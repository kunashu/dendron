import {
  DendronCompositeError,
  DendronError,
  DLogger,
  DVault,
  errAsync,
  ERROR_SEVERITY,
  ERROR_STATUS,
  IDendronError,
  IFileStore,
  isNotNull,
  isNotUndefined,
  okAsync,
  RespWithOptError,
  Result,
  ResultAsync,
  ResultUtils,
  SchemaModuleDict,
  SchemaModuleProps,
  VaultUtils,
} from "@dendronhq/common-all";
import { vault2Path } from "@dendronhq/common-server";
import _ from "lodash";
import { Database } from "sqlite3";
import { URI } from "vscode-uri";
import { parseAllNoteFilesForSqlite, SchemaParser } from "../file";
import { SqliteQueryUtils } from "./SqliteQueryUtils";
import { HierarchyTableUtils, VaultsTableUtils } from "./tables";
import { LinksTableUtils } from "./tables/LinksTableUtils";
import { NotePropsFtsTableUtils } from "./tables/NotePropsFtsTableUtils";
import { NotePropsTableUtils } from "./tables/NotePropsTableUtils";
import { SchemaNotesTableUtils } from "./tables/SchemaNotesTableUtils";
import { VaultNotesTableUtils } from "./tables/VaultNotesTableUtils";

/**
 * Factory methods to create a SQLite database
 */
export class SqliteDbFactory {
  /**
   * This creates a SQLite database AND also initializes it with all notes that
   * are a part of the passed in vaults
   * @param wsRoot
   * @param vaults
   * @param fileStore
   * @param dbFilePath - path of the db file. Use :memory: to use an in-memory database
   * @returns
   */
  public static async createInitializedDB(
    wsRoot: string,
    vaults: DVault[],
    fileStore: IFileStore,
    dbFilePath: string,
    logger: DLogger
  ): Promise<Result<Database, Error>> {
    return SqliteDbFactory.createEmptyDB(dbFilePath).andThen((db) => {
      const results = ResultAsync.combine(
        // Initialize Each Vault
        vaults.map((vault) => {
          const vaultPath = vault2Path({ vault, wsRoot });
          // Get list of files from the filesystem for the vault
          return ResultAsync.fromPromise(
            fileStore.readDir({
              root: URI.parse(vaultPath),
              include: ["*.md"],
            }),
            (e) => {
              return e;
            }
          ).map((maybeFiles) => {
            return parseAllNoteFilesForSqlite(
              maybeFiles.data!,
              vault,
              db,
              vaultPath,
              // schemaDict,
              false,
              logger
            );
          });
        })
      );
      return results.map(() => {
        return db;
      });
    }) as ResultAsync<Database, Error>;
  }

  /**
   * This method will create a sqlite database with the table schema created,
   * but no initial data is added. Useful for tests.
   * @param dbFilePath - path of the db file. Use :memory: to use an in-memory database
   * @returns
   */
  public static createEmptyDB(
    dbFilePath: string
  ): ResultAsync<Database, Error> {
    const prom = new Promise<Database>((resolve, reject) => {
      const db = new Database(dbFilePath, (err) => {
        if (err) {
          reject(err.message);
        }

        resolve(db);
      });
    });

    return ResultAsync.fromPromise(prom, (e) => {
      return e as Error;
    }).andThen((db) => {
      // First create the relation-less tables first (vaults and NoteProps):
      return ResultAsync.combine([
        VaultsTableUtils.createTable(db),
        NotePropsTableUtils.createTable(db),
        LinksTableUtils.createTable(db),
      ])
        .andThen(() => {
          // Now create tables with relations
          return ResultAsync.combine([
            VaultNotesTableUtils.createTable(db),
            HierarchyTableUtils.createTable(db),
            SchemaNotesTableUtils.createTable(db),
            NotePropsFtsTableUtils.createTable(db),
            // Enable Foreign Key relationships:
            SqliteQueryUtils.run(db, "PRAGMA foreign_keys = ON"),
          ]);
        })
        .map(() => {
          return db;
        });
    });
  }

  static initSchema(
    vaults: DVault[],
    wsRoot: string,
    fileStore: IFileStore,
    logger: DLogger
  ): ResultAsync<SchemaModuleDict, IDendronError> {
    const schemaParser = new SchemaParser({
      wsRoot,
      logger,
    });
    const schemaDict: SchemaModuleDict = {};
    let errors: DendronError[] = [];
    ResultAsync.combineWithAllErrors(
      vaults.map((vault) => {
        const vaultPath = vault2Path({ vault, wsRoot });
        return ResultUtils.PromiseRespV3ToResultAsync(
          fileStore.readDir({
            root: URI.file(vaultPath),
            include: ["*.schema.yml"],
          })
        ).andThen<Awaited<ReturnType<SchemaParser["parse"]>>, never>(
          (schemaFiles) => {
            const out = ResultAsync.fromSafePromise(
              schemaParser.parse(schemaFiles, vault)
            );
            return out;
          }
        );
      })
    ).map((res) => {
      const schemaResponses = res as Awaited<
        ReturnType<SchemaParser["parse"]>
      >[];
      errors = schemaResponses
        .flatMap((response) => response.errors)
        .filter(isNotNull);
      const schemas = schemaResponses
        .flatMap((response) => response.schemas)
        .filter(isNotUndefined);

      schemas.forEach((schema) => {
        schemaDict[schema.root.id] = schema;
      });
    });

    if (errors.length > 0) {
      return errAsync(new DendronCompositeError(errors));
    } else {
      return okAsync(schemaDict);
    }
  }

  static async readAllSchema(
    vaults: DVault[],
    wsRoot: string,
    fileStore: IFileStore,
    logger: DLogger
  ): Promise<RespWithOptError<SchemaModuleProps[]>> {
    const ctx = "DEngine:initSchema";
    logger.info({ ctx, msg: "enter" });
    let errorList: IDendronError[] = [];

    const schemaResponses: RespWithOptError<SchemaModuleProps[]>[] =
      await Promise.all(
        vaults.map(async (vault) => {
          const vpath = vault2Path({ vault, wsRoot });
          // Get list of files from filesystem
          const maybeFiles = await fileStore.readDir({
            root: URI.file(vpath),
            include: ["*.schema.yml"],
          });
          if (maybeFiles.error || maybeFiles.data.length === 0) {
            // Keep initializing other vaults
            return {
              error: new DendronCompositeError([
                new DendronError({
                  message: `Unable to get schemas for vault ${VaultUtils.getName(
                    vault
                  )}`,
                  status: ERROR_STATUS.NO_SCHEMA_FOUND,
                  severity: ERROR_SEVERITY.MINOR,
                  payload: maybeFiles.error,
                }),
              ]),
              data: [],
            };
          }
          const schemaFiles = maybeFiles.data.map((entry) => entry.toString());
          logger.info({ ctx, schemaFiles });
          const { schemas, errors } = await new SchemaParser({
            wsRoot,
            logger,
          }).parse(schemaFiles, vault);

          if (errors) {
            errorList = errorList.concat(errors);
          }
          return {
            data: schemas,
            error: _.isNull(errors)
              ? undefined
              : new DendronCompositeError(errors),
          };
        })
      );
    const errors = schemaResponses
      .flatMap((response) => response.error)
      .filter(isNotUndefined);

    return {
      error: errors.length > 0 ? new DendronCompositeError(errors) : undefined,
      data: schemaResponses
        .flatMap((response) => response.data)
        .filter(isNotUndefined),
    };
  }
}
