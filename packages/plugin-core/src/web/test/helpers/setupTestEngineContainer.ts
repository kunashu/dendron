import {
  DVault,
  DVaultUriVariant,
  EngineEventEmitter,
  genUUID,
  IDataStore,
  IFileStore,
  INoteStore,
  NoteMetadataStore,
  NoteProps,
  NotePropsMeta,
  NoteStore,
  NoteUtils,
} from "@dendronhq/common-all";
import { container, Lifecycle } from "tsyringe";
import { ILookupProvider } from "../../commands/lookup/ILookupProvider";
import { NoteLookupProvider } from "../../commands/lookup/NoteLookupProvider";
import { DendronEngineV3Web } from "../../engine/DendronEngineV3Web";
import { IReducedEngineAPIService } from "../../engine/IReducedEngineApiService";
import { VSCodeFileStore } from "../../engine/store/VSCodeFileStore";
import { ITreeViewConfig } from "../../views/treeView/ITreeViewConfig";
import { TreeViewDummyConfig } from "../../views/treeView/TreeViewDummyConfig";

import _ from "lodash";
import { URI, Utils } from "vscode-uri";
import { note2File } from "../../utils/note2File";
import { WorkspaceHelpers } from "./WorkspaceHelpers";

/**
 * Prepare a test container for running a real engine against a temporary
 * vault/note set. For most tests, this won't actually be necessary because we
 * can just run against in-memory notes
 */
export async function setupTestEngineContainer() {
  const wsRoot = await setupTestFiles();

  const vaults = await getVaults(wsRoot);

  await setupHierarchyForLookupTests(vaults, wsRoot);

  container.register<EngineEventEmitter>("EngineEventEmitter", {
    useToken: "IReducedEngineAPIService",
  });

  // Getting a DendronEngineV3Web instance is necessary for testing so that you
  // can call init() on it prior to running the test
  container.register<EngineEventEmitter>(DendronEngineV3Web, {
    useToken: "IReducedEngineAPIService",
  });

  container.register<IReducedEngineAPIService>(
    "IReducedEngineAPIService",
    {
      useClass: DendronEngineV3Web,
    },
    { lifecycle: Lifecycle.Singleton }
  );

  container.register<IFileStore>("IFileStore", {
    useClass: VSCodeFileStore,
  });

  container.register<IDataStore<string, NotePropsMeta>>(
    "IDataStore",
    {
      useClass: NoteMetadataStore,
    },
    { lifecycle: Lifecycle.Singleton }
  );

  container.register("wsRoot", { useValue: wsRoot });
  container.register("vaults", { useValue: vaults });

  const fs = container.resolve<IFileStore>("IFileStore");
  const ds = container.resolve<IDataStore<string, NotePropsMeta>>("IDataStore");

  const noteStore = new NoteStore(fs, ds, wsRoot);

  container.register<INoteStore<string>>("INoteStore", {
    useValue: noteStore,
  });

  container.register<ILookupProvider>("NoteProvider", {
    useClass: NoteLookupProvider,
  });

  container.register<ITreeViewConfig>("ITreeViewConfig", {
    useClass: TreeViewDummyConfig,
  });
}

async function setupTestFiles(): Promise<URI> {
  const wsRoot = await WorkspaceHelpers.getWSRootForTest();

  return wsRoot;
}

async function getVaults(wsRoot: URI): Promise<DVaultUriVariant[]> {
  const vaults: DVaultUriVariant[] = [
    { fsPath: "vault1", path: Utils.joinPath(wsRoot, "vault1") },
    // { fsPath: "vault2", path: Utils.joinPath(wsRoot, "vault2") },
    // {
    //   fsPath: "vault3",
    //   name: "vaultThree",
    //   path: Utils.joinPath(wsRoot, "vault3"),
    // },
  ];

  return vaults;
}

// Logic below is temporarily borrowed from engine-test-utils:
async function setupHierarchyForLookupTests(vaults: DVault[], wsRoot: URI) {
  const opts = {
    vault: vaults[0],
    wsRoot,
  };
  const fnames = [
    "root",
    "foo",
    "foo.ch1",
    "foo.ch1.gch1",
    "foo.ch1.gch1.ggch1",
    "foo.ch1.gch2",
    "foo.ch2",
    "bar",
    "bar.ch1",
    "bar.ch1.gch1",
    "bar.ch1.gch1.ggch1",
    "goo.ends-with-ch1.no-ch1-by-itself",
  ];

  return Promise.all(
    fnames.map((fname) => {
      return createNote({ ...opts, fname });
    })
  );
}

type CreateNoteOptsV4 = {
  vault: DVault;
  wsRoot: URI;
  fname: string;
  body?: string;
  props?: Partial<Omit<NoteProps, "vault" | "fname" | "body" | "custom">>;
  genRandomId?: boolean;
  noWrite?: boolean;
  custom?: any;
  stub?: boolean;
};

async function createNote(opts: CreateNoteOptsV4) {
  const {
    fname,
    vault,
    props,
    body,
    genRandomId,
    noWrite,
    wsRoot,
    custom,
    stub,
  } = _.defaults(opts, { noWrite: false });
  /**
   * Make sure snapshots stay consistent
   */
  const defaultOpts = {
    created: 1,
    updated: 1,
    id: genRandomId ? genUUID() : fname,
  };

  const note = NoteUtils.create({
    ...defaultOpts,
    ...props,
    custom,
    fname,
    vault,
    body,
    stub,
  });
  if (!noWrite && !stub) {
    await note2File({ note, vault, wsRoot });
  }
  return note;
}
