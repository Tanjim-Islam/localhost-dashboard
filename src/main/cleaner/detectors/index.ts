import type { CleanerDetector } from "../types";
import { BrowserAndElectronDetector } from "./browsers-electron";
import { BuildToolCacheDetector } from "./build-tools";
import { IdeLeftoverDetector } from "./ide-leftovers";
import { NodeCacheDetector } from "./node";
import { ProjectArtifactDetector } from "./project-artifacts";
import { ProtectedStoreDetector } from "./protected-stores";
import { PythonCacheDetector } from "./python";
import { WindowsDataDetector } from "./windows-data";
import { ApplicationCacheDetector } from "./application-caches";

export function createCleanerDetectors(): CleanerDetector[] {
  return [
    new NodeCacheDetector(),
    new PythonCacheDetector(),
    new BuildToolCacheDetector(),
    new IdeLeftoverDetector(),
    new ApplicationCacheDetector(),
    new BrowserAndElectronDetector(),
    new WindowsDataDetector(),
    new ProtectedStoreDetector(),
    new ProjectArtifactDetector(),
  ];
}
