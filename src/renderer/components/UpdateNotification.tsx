import React, { useState, useEffect } from "react";

type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string; releaseNotes?: string }
  | { state: "not-available"; version: string }
  | { state: "downloading"; percent: number; transferred: number; total: number }
  | { state: "downloaded"; version: string }
  | { state: "error"; message: string };

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

export default function UpdateNotification() {
  const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });
  const [visible, setVisible] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Get initial status
    window.api.getUpdateStatus().then(setStatus);

    // Listen for status updates
    const off = window.api.onUpdateStatus((newStatus) => {
      setStatus(newStatus);
      setDismissed(false);
    });

    return () => off?.();
  }, []);

  // Determine visibility based on status
  useEffect(() => {
    const shouldShow =
      !dismissed &&
      (status.state === "checking" ||
        status.state === "available" ||
        status.state === "downloading" ||
        status.state === "downloaded" ||
        status.state === "error" ||
        status.state === "not-available");

    if (shouldShow) {
      setVisible(true);
    } else {
      // Delay hiding for animation
      const timeout = setTimeout(() => setVisible(false), 300);
      return () => clearTimeout(timeout);
    }
  }, [status, dismissed]);

  const handleDismiss = () => {
    setDismissed(true);
    window.api.dismissUpdate();
  };

  const handleDownload = () => {
    window.api.downloadUpdate();
  };

  const handleInstall = () => {
    window.api.installUpdate();
  };

  const handleCheckAgain = () => {
    window.api.checkForUpdates();
  };

  if (!visible && status.state === "idle") {
    return null;
  }

  const isVisible = visible && !dismissed;
  const isDarkCard = status.state === "not-available";

  return (
    <div
      className={`
        fixed bottom-5 right-5 z-50 
        transition-all duration-300 ease-out
        ${isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4 pointer-events-none"}
      `}
    >
      <div
        className={`rounded-2xl shadow-2xl overflow-hidden min-w-[320px] max-w-[380px] ${
          isDarkCard
            ? "bg-gray-800 border border-gray-700"
            : "bg-gray-100 border border-gray-300"
        }`}
      >
        {/* Header */}
        <div
          className={`flex items-center justify-between px-4 py-3 border-b ${
            isDarkCard ? "border-gray-700 bg-gray-700" : "border-gray-200 bg-gray-50"
          }`}
        >
          <div className="flex items-center gap-2">
            <UpdateIcon state={status.state} />
            <span
              className={`font-semibold text-sm ${
                isDarkCard ? "text-gray-100" : "text-gray-900"
              }`}
            >
              {status.state === "checking" && "Checking for updates..."}
              {status.state === "available" && "Update Available"}
              {status.state === "not-available" && "You're up to date"}
              {status.state === "downloading" && "Downloading Update"}
              {status.state === "downloaded" && "Ready to Install"}
              {status.state === "error" && "Update Error"}
            </span>
          </div>
          {(status.state === "available" ||
            status.state === "error" ||
            status.state === "not-available") && (
            <button
              onClick={handleDismiss}
              className={`w-6 h-6 rounded-full flex items-center justify-center transition-colors ${
                isDarkCard
                  ? "text-gray-200 hover:text-gray-50 hover:bg-gray-600"
                  : "text-gray-500 hover:text-gray-700 hover:bg-gray-200"
              }`}
              aria-label="Dismiss"
            >
              ×
            </button>
          )}
        </div>

        {/* Content */}
        <div className="px-4 py-3">
          {/* Checking state */}
          {status.state === "checking" && (
            <div className="flex items-center gap-3">
              <div className="w-5 h-5 border-2 border-celadon-400 border-t-transparent rounded-full animate-spin" />
              <span className="text-gray-600 text-sm">Looking for new versions...</span>
            </div>
          )}

          {/* Available state */}
          {status.state === "available" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <span className="text-gray-600 text-sm">New version</span>
                <span className="bg-celadon-400/20 text-celadon-700 px-2 py-0.5 rounded-full text-xs font-semibold">
                  v{status.version}
                </span>
              </div>
              <button
                onClick={handleDownload}
                className="w-full py-2.5 rounded-xl bg-celadon-400 text-white font-medium text-sm hover:bg-celadon-500 active:scale-[0.98] transition-all duration-150 shadow-sm"
              >
                Download Update
              </button>
            </div>
          )}

          {/* Not available state */}
          {status.state === "not-available" && (
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5 text-celadon-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span className={`${isDarkCard ? "text-gray-100" : "text-gray-600"} text-sm`}>
                Running latest version{" "}
                <span className={`font-medium ${isDarkCard ? "text-gray-50" : "text-gray-800"}`}>
                  v{status.version}
                </span>
              </span>
            </div>
          )}

          {/* Downloading state */}
          {status.state === "downloading" && (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-gray-600">Downloading...</span>
                <span className="text-gray-800 font-medium">{Math.round(status.percent)}%</span>
              </div>
              <div className="relative h-2 bg-gray-200 rounded-full overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 bg-gradient-to-r from-celadon-400 to-celadon-500 rounded-full transition-all duration-300 ease-out"
                  style={{ width: `${status.percent}%` }}
                />
                {/* Shimmer effect */}
                <div
                  className="absolute inset-0 bg-gradient-to-r from-transparent via-white/30 to-transparent animate-shimmer"
                  style={{ backgroundSize: "200% 100%" }}
                />
              </div>
              <div className="flex items-center justify-between text-xs text-gray-500">
                <span>{formatBytes(status.transferred)}</span>
                <span>{formatBytes(status.total)}</span>
              </div>
            </div>
          )}

          {/* Downloaded state */}
          {status.state === "downloaded" && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <svg className="w-5 h-5 text-celadon-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <span className="text-gray-600 text-sm">
                  Version <span className="font-medium text-gray-800">v{status.version}</span> ready
                </span>
              </div>
              <button
                onClick={handleInstall}
                className="w-full py-2.5 rounded-xl bg-gradient-to-r from-celadon-400 to-celadon-500 text-white font-medium text-sm hover:from-celadon-500 hover:to-celadon-600 active:scale-[0.98] transition-all duration-150 shadow-sm flex items-center justify-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                Restart & Install
              </button>
            </div>
          )}

          {/* Error state */}
          {status.state === "error" && (
            <div className="space-y-3">
              <div className="flex items-start gap-2">
                <svg className="w-5 h-5 text-mimi_pink-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <span className="text-gray-600 text-sm">{status.message}</span>
              </div>
              <button
                onClick={handleCheckAgain}
                className="w-full py-2 rounded-xl bg-gray-200 text-gray-700 font-medium text-sm hover:bg-gray-300 active:scale-[0.98] transition-all duration-150"
              >
                Try Again
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function UpdateIcon({ state }: { state: string }) {
  if (state === "checking") {
    return (
      <div className="w-5 h-5 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
    );
  }

  if (state === "available" || state === "downloading") {
    return (
      <svg className="w-5 h-5 text-celadon-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
      </svg>
    );
  }

  if (state === "downloaded" || state === "not-available") {
    return (
      <svg className="w-5 h-5 text-celadon-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    );
  }

  if (state === "error") {
    return (
      <svg className="w-5 h-5 text-mimi_pink-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    );
  }

  return null;
}

