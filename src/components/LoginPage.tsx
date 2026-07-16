import { useState } from "react";
import { useAuthStore } from "../stores/authStore";

export default function LoginPage() {
  const [pin, setPin] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const loginWithPin = useAuthStore((s) => s.loginWithPin);

  async function handleDigit(d: string) {
    if (pin.length >= 6) return;
    const next = pin + d;
    setPin(next);
    setError("");
    if (next.length === 6) {
      setLoading(true);
      const err = await loginWithPin(next);
      if (err) {
        setError(err);
        setPin("");
      }
      setLoading(false);
    }
  }

  function handleBackspace() {
    setPin((p) => p.slice(0, -1));
    setError("");
  }

  return (
    <div className="min-h-screen w-full bg-canvas flex items-center justify-center" dir="rtl">
      <div className="w-full max-w-xs flex flex-col items-center gap-8">
        <div className="text-center">
          <div
            className="w-14 h-14 rounded-[13px] flex items-center justify-center text-white text-2xl font-bold mx-auto mb-4"
            style={{ backgroundColor: "var(--accent)" }}
          >
            ز
          </div>
          <h1 className="text-2xl font-bold text-text mb-1">زعيم</h1>
          <p className="text-sm text-text-3">نظام إدارة المطاعم</p>
        </div>

        {error && (
          <div className="w-full p-3 rounded-[10px] bg-danger text-white text-sm text-center font-medium">
            {error}
          </div>
        )}

        <div className="flex gap-3" style={{ direction: "ltr" }}>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="w-3.5 h-3.5 rounded-full transition-all"
              style={{
                backgroundColor: pin.length > i ? "var(--accent)" : "var(--line)",
              }}
            />
          ))}
        </div>

        <div className="grid grid-cols-3 gap-3 w-full">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"].map((k) => {
            if (k === "") return <div key="empty" />;
            if (k === "⌫") {
              return (
                <button
                  key={k}
                  onClick={handleBackspace}
                  className="rounded-[12px] bg-surface-alt text-text-2 text-xl font-medium transition-all active:scale-95 shadow-sh-1"
                  style={{ minHeight: 52, minWidth: 52 }}
                >
                  ⌫
                </button>
              );
            }
            return (
              <button
                key={k}
                onClick={() => handleDigit(k)}
                disabled={loading}
                className="rounded-[12px] bg-surface text-text text-xl font-medium transition-all active:scale-95 shadow-sh-1 disabled:opacity-50"
                style={{ minHeight: 52, minWidth: 52 }}
              >
                {k}
              </button>
            );
          })}
        </div>

        {loading && (
          <div className="text-sm text-text-muted">جاري التحقق...</div>
        )}

        <div className="text-center mt-4">
          {import.meta.env.DEV && (
            <button
              onClick={async () => {
                setLoading(true);
                const err = await loginWithPin("123456");
                if (err) setError(err);
                setLoading(false);
              }}
              className="text-sm text-text-3 underline hover:text-text-2"
            >
              دخول سريع (dev)
            </button>
          )}
          <p className="text-[10px] text-text-muted mt-2">Zaeem POS © 2026</p>
        </div>
      </div>
    </div>
  );
}
