export type TitleBarLayout = {
  rootPaddingClass: string;
  showWindowControls: boolean;
  showLeadingStatusDot: boolean;
};

export function getTitleBarLayout(platform?: string): TitleBarLayout {
  const isMac = platform === "darwin";

  return {
    rootPaddingClass: isMac ? "pl-[86px]" : "pl-3",
    showWindowControls: !isMac,
    showLeadingStatusDot: false,
  };
}
