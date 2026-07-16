"use client";

import { useEffect, useState } from "react";
import { MonitorDown } from "lucide-react";

// Chrome/Edge/Android fire beforeinstallprompt; iOS Safari never does, so
// there the button explains the Share -> Add to Home Screen path instead.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function InstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(true);
  const [isIos, setIsIos] = useState(false);
  const [showIosHelp, setShowIosHelp] = useState(false);

  useEffect(() => {
    Promise.resolve().then(() => {
      setInstalled(
        window.matchMedia("(display-mode: standalone)").matches ||
          (navigator as { standalone?: boolean }).standalone === true,
      );
      setIsIos(/iPad|iPhone|iPod/.test(navigator.userAgent));
    });
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setInstalled(true);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (installed || (!deferred && !isIos)) return null;

  const onClick = async () => {
    if (deferred) {
      await deferred.prompt();
      const choice = await deferred.userChoice;
      if (choice.outcome === "accepted") setDeferred(null);
    } else {
      setShowIosHelp((v) => !v);
    }
  };

  return (
    <div className="flex flex-col items-center gap-2">
      <button
        onClick={onClick}
        className="glass-card flex min-h-11 items-center gap-2 rounded-full px-5 text-sm font-medium transition hover:border-accent/40 active:scale-[0.99]"
      >
        <MonitorDown size={16} className="text-accent" /> Install to device
      </button>
      {showIosHelp && (
        <p className="max-w-xs text-xs text-muted-foreground">
          In Safari, tap the Share button, then &ldquo;Add to Home Screen&rdquo;.
        </p>
      )}
    </div>
  );
}
