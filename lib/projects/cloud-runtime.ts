import { openChallengeDraftJournal, type ChallengeDraftJournal } from "../memories/challenge-drafts";
import { createCloudProjectClient, type CloudIdentity, type CloudProjectClient } from "./cloud-client";
import { createCloudUploadManager, openCloudUploadJournal, type CloudUploadJournal, type CloudUploadManager } from "./cloud-upload";
import { createChallengeClient, type ChallengeClient } from "../memories/challenge-client";
import { cloudUuid } from "./cloud-contract";
import { openCloudDesignJournal, type CloudDesignJournal } from "./cloud-design-journal";
import { createCloudDesignSaveCoordinator, type CloudDesignSaveCoordinator, type CloudDesignSaveOptions } from "./cloud-design-save";
import { openProjectRepository } from "./storage";

export interface AccountCloudRuntime { client: CloudProjectClient; uploads: CloudUploadManager; challenges: ChallengeClient; drafts: ChallengeDraftJournal; designs: CloudDesignSaveCoordinator }
export interface AccountCloudRuntimeOptions {
  ownerId: string; appOrigin: string; storageOrigin: string;
  accessToken(): Promise<string | null>;
  subscribe(listener: (ownerId: string | null) => void): () => void;
  onInvalidated?(): void;
  loadBlob?: CloudDesignSaveOptions["loadBlob"];
}
export interface AccountCloudRuntimePorts {
  client: typeof createCloudProjectClient;
  journal: typeof openCloudUploadJournal;
  challenges: typeof createChallengeClient;
  uploads: typeof createCloudUploadManager;
  drafts: typeof openChallengeDraftJournal;
  designJournal: typeof openCloudDesignJournal;
  designs: typeof createCloudDesignSaveCoordinator;
}
let nextEpoch = 0;
export function openAccountCloudRuntime(options: AccountCloudRuntimeOptions, ports: AccountCloudRuntimePorts = { client: createCloudProjectClient, journal: openCloudUploadJournal, challenges: createChallengeClient, uploads: createCloudUploadManager, drafts: openChallengeDraftJournal, designJournal: openCloudDesignJournal, designs: createCloudDesignSaveCoordinator }) {
  const ownerId = cloudUuid(options.ownerId);
  let identity: CloudIdentity | null = { ownerId, epoch: ++nextEpoch }, stopped = false;
  let client: CloudProjectClient | undefined, journal: CloudUploadJournal | undefined, challenges: ChallengeClient | undefined, uploads: CloudUploadManager | undefined;
  let drafts: ChallengeDraftJournal | undefined;
  let designJournal: CloudDesignJournal | undefined, designs: CloudDesignSaveCoordinator | undefined;
  let unsubscribe: (() => void) | undefined;
  const close = () => {
    if (stopped) return;
    stopped = true; identity = null;
    unsubscribe?.(); client?.close(); challenges?.close(); designs?.close(); uploads?.close(); journal?.close(); drafts?.close();
    if (!designs) designJournal?.close();
  };
  const ready = Promise.resolve().then(async (): Promise<AccountCloudRuntime> => {
    try {
      if (stopped) throw new Error("cancelled");
      unsubscribe = options.subscribe(current => {
        if (stopped || current === ownerId) return;
        close(); options.onInvalidated?.();
      });
      if (stopped) { unsubscribe(); throw new Error("account_changed"); }
      const account = { appOrigin: options.appOrigin, identity: () => identity, accessToken: options.accessToken };
      client = ports.client({ ...account, storageOrigin: options.storageOrigin });
      journal = await ports.journal(ownerId, { identity: () => identity });
      if (stopped) { journal.close(); throw new Error("account_changed"); }
      drafts = await ports.drafts(ownerId, { identity: () => identity });
      if (stopped) { drafts.close(); throw new Error("account_changed"); }
      designJournal = await ports.designJournal(ownerId, { identity: () => identity });
      if (stopped) { designJournal.close(); throw new Error("account_changed"); }
      client.assertActive();
      challenges = ports.challenges(account);
      uploads = ports.uploads({ client, journal });
      const accountClient = client;
      const loadBlob: CloudDesignSaveOptions["loadBlob"] = options.loadBlob ?? (async (projectId, mediaId, signal) => {
        accountClient.assertActive(signal);
        const repository = await openProjectRepository({ kind: "account", ownerId });
        try {
          accountClient.assertActive(signal);
          const loaded = await repository.load(projectId);
          accountClient.assertActive(signal);
          return loaded?.kind === "current" ? loaded.media.get(mediaId) ?? null : null;
        } finally { repository.close(); }
      });
      designs = ports.designs({ client, uploads, uploadJournal: journal, journal: designJournal, loadBlob });
      return { client, uploads, challenges, drafts, designs };
    } catch (error) { close(); throw error; }
  });
  return { ready, close };
}
