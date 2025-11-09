declare module 'auto-launch' {
  export interface AutoLaunchOptions {
    name: string;
    path?: string;
    isHidden?: boolean;
  }

  export default class AutoLaunch {
    constructor(options: AutoLaunchOptions);
    enable(): Promise<void>;
    disable(): Promise<void>;
    isEnabled(): Promise<boolean>;
  }
}

