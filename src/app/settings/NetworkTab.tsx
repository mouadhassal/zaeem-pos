import { useCallback, useEffect, useState } from "react";
import { invoke } from "../../lib/invoke";
import { invalidateLanTargetCache } from "../../lib/lan";

interface LanStatus {
  mode: string;
  deviceName: string;
  hubAddr: string | null;
  paired: boolean;
}

interface PendingPairing {
  id: string;
  deviceName: string;
  deviceRole: string;
  requestedAt: string;
}

interface PairedTerminal {
  id: string;
  deviceName: string;
  deviceRole: string;
  status: string;
  lastSeenAt: string | null;
}

function roleLabel(role: string): string {
  return role === "kitchen" ? "شاشة مطبخ (مجاني)" : "كاشير / نقطة بيع (بترخيص)";
}

interface DiscoveredHub {
  name: string;
  addr: string;
}

/**
 * The real implementation behind the old "cloud sync -- قريباً" placeholder's
 * "تشغيل متعدد الأجهزة" (multi-device operation) promise -- one terminal per
 * branch runs as the Hub, every other terminal (a KDS, a second register)
 * pairs to it as a Satellite. See `lan.rs` for the full design: mDNS
 * discovery, one-tap approval, then silent/automatic reconnection forever.
 */
export default function NetworkTab({ token }: { token: string | null }) {
  const [status, setStatus] = useState<LanStatus | null>(null);
  const [pending, setPending] = useState<PendingPairing[]>([]);
  const [paired, setPaired] = useState<PairedTerminal[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredHub[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairingWait, setPairingWait] = useState(false);
  const [joinRole, setJoinRole] = useState<"register" | "kitchen">("kitchen");

  const refresh = useCallback(async () => {
    try {
      const s = await invoke<LanStatus>("get_lan_status_v3", { sessionToken: token });
      setStatus(s);
      if (s.mode === "hub") {
        const [pendingRows, pairedRows] = await Promise.all([
          invoke<PendingPairing[]>("list_pending_pairings_v3", { sessionToken: token }),
          invoke<PairedTerminal[]>("list_paired_terminals_v3", { sessionToken: token }),
        ]);
        setPending(pendingRows);
        setPaired(pairedRows);
      }
    } catch (err) {
      setError(typeof err === "string" ? err : "حدث خطأ في تحميل حالة الشبكة");
    }
  }, [token]);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 5000);
    return () => clearInterval(interval);
  }, [refresh]);

  // While a satellite pairing request is PENDING on the Hub, poll every
  // couple of seconds until the Hub operator approves it -- the frontend
  // equivalent of "بانتظار موافقة المدير".
  useEffect(() => {
    if (status?.mode !== "satellite" || status.paired) return;
    setPairingWait(true);
    const interval = setInterval(async () => {
      try {
        const res = await invoke<{ status: string }>("check_pairing_status_v3", {});
        if (res.status === "APPROVED") {
          invalidateLanTargetCache();
          await refresh();
          setPairingWait(false);
        }
      } catch {
        // hub unreachable this tick -- keep waiting silently
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [status, refresh]);

  const becomeHub = async () => {
    setBusy(true);
    setError(null);
    try {
      await invoke("enable_hub_mode_v3", { sessionToken: token });
      invalidateLanTargetCache();
      await refresh();
    } catch (err) {
      setError(typeof err === "string" ? err : "حدث خطأ في تفعيل وضع المركز");
    } finally {
      setBusy(false);
    }
  };

  const runDiscovery = async () => {
    setDiscovering(true);
    setError(null);
    try {
      setDiscovered(await invoke<DiscoveredHub[]>("discover_hubs_v3", {}));
    } catch (err) {
      setError(typeof err === "string" ? err : "حدث خطأ في البحث عن الأجهزة");
    } finally {
      setDiscovering(false);
    }
  };

  const joinHub = async (hub: DiscoveredHub) => {
    setBusy(true);
    setError(null);
    try {
      await invoke("request_pairing_v3", {
        hubAddr: hub.addr,
        deviceName: status?.deviceName ?? "POS Terminal",
        deviceRole: joinRole,
      });
      invalidateLanTargetCache();
      await refresh();
    } catch (err) {
      setError(typeof err === "string" ? err : "حدث خطأ في طلب الإقران");
    } finally {
      setBusy(false);
    }
  };

  const forgetPairing = async () => {
    setBusy(true);
    setError(null);
    try {
      await invoke("forget_pairing_v3", {});
      invalidateLanTargetCache();
      await refresh();
    } catch (err) {
      setError(typeof err === "string" ? err : "حدث خطأ");
    } finally {
      setBusy(false);
    }
  };

  const approve = async (id: string) => {
    try {
      await invoke("approve_pairing_v3", { sessionToken: token, requestId: id });
      await refresh();
    } catch {
      setError("حدث خطأ في الموافقة على الجهاز");
    }
  };

  const reject = async (id: string) => {
    try {
      await invoke("reject_pairing_v3", { sessionToken: token, requestId: id });
      await refresh();
    } catch {
      setError("حدث خطأ في رفض الجهاز");
    }
  };

  const revoke = async (id: string) => {
    if (!window.confirm("هل تريد إلغاء ارتباط هذا الجهاز؟ لن يتمكن بعدها من الوصول لبيانات الفرع.")) return;
    try {
      await invoke("revoke_terminal_v3", { sessionToken: token, terminalId: id });
      await refresh();
    } catch {
      setError("حدث خطأ في إلغاء ارتباط الجهاز");
    }
  };

  if (!status) {
    return <div className="max-w-xl text-sm text-ink-400 font-arabic">جاري التحميل...</div>;
  }

  return (
    <div className="space-y-6 max-w-xl">
      <h2 className="text-lg font-bold text-ink-900 font-arabic">الشبكة المحلية (تشغيل متعدد الأجهزة)</h2>
      <p className="text-xs text-ink-400 font-arabic">
        اجعل جهازاً واحداً في الفرع &quot;مركزياً&quot; -- بقية الأجهزة (شاشة المطبخ، كاشير ثانٍ) تتصل به تلقائياً عبر
        الشبكة المحلية لمشاركة نفس الطاولات والطلبات لحظياً، دون الحاجة للإنترنت.
      </p>

      {error && (
        <div className="bg-danger-soft border border-danger-soft rounded-md p-3 text-danger font-arabic text-sm">{error}</div>
      )}

      <div className="bg-white rounded-md p-5 border border-ink-200 space-y-2">
        <div className="flex justify-between text-sm">
          <span className="font-arabic text-ink-400">اسم هذا الجهاز</span>
          <span className="font-mono text-ink-900">{status.deviceName}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="font-arabic text-ink-400">الوضع الحالي</span>
          <span className="font-arabic font-bold text-ink-900">
            {status.mode === "hub" ? "مركزي (Hub)" : status.mode === "satellite" ? "فرعي (متصل بمركز)" : "مستقل"}
          </span>
        </div>
      </div>

      {status.mode === "standalone" && (
        <div className="bg-white rounded-md p-5 border border-ink-200 space-y-4">
          <div>
            <p className="text-sm font-arabic text-ink-900 font-bold mb-1">جعل هذا الجهاز مركزياً</p>
            <p className="text-xs font-arabic text-ink-400 mb-2">
              اختر هذا في الجهاز الذي يعمل طوال الوقت (عادة الكاشير الرئيسي). بقية الأجهزة تتصل به.
            </p>
            <button
              onClick={becomeHub}
              disabled={busy}
              className="h-10 px-6 rounded-sm bg-saffron-600 text-white text-sm font-bold hover:bg-saffron-700 transition-colors disabled:opacity-50"
            >
              اجعل هذا الجهاز مركزياً
            </button>
          </div>
          <div className="border-t border-ink-200 pt-4">
            <p className="text-sm font-arabic text-ink-900 font-bold mb-1">الاتصال بجهاز مركزي</p>
            <p className="text-xs font-arabic text-ink-400 mb-2">
              اختر هذا في أي جهاز آخر (شاشة مطبخ، كاشير إضافي) بعد تفعيل جهاز مركزي في نفس الشبكة.
            </p>
            <div className="flex gap-2 mb-3">
              <button
                onClick={() => setJoinRole("kitchen")}
                className={`flex-1 h-10 rounded-sm text-xs font-arabic transition-colors ${joinRole === "kitchen" ? "bg-saffron-600 text-white" : "bg-white border-2 border-ink-200 text-ink-500"}`}
              >
                شاشة مطبخ فقط (مجاني)
              </button>
              <button
                onClick={() => setJoinRole("register")}
                className={`flex-1 h-10 rounded-sm text-xs font-arabic transition-colors ${joinRole === "register" ? "bg-saffron-600 text-white" : "bg-white border-2 border-ink-200 text-ink-500"}`}
              >
                كاشير / نقطة بيع (يتطلب ترخيصاً لهذا الجهاز)
              </button>
            </div>
            {joinRole === "register" && (
              <p className="text-xs font-arabic text-amber-700 mb-2">
                هذا الجهاز يعمل كنقطة بيع كاملة (طلبات، دفع، ورديات) -- يجب تفعيل ترخيص خاص به من تبويب &quot;الترخيص&quot; قبل الاتصال.
              </p>
            )}
            <button
              onClick={runDiscovery}
              disabled={discovering}
              className="h-10 px-6 rounded-sm bg-white border-2 border-ink-200 text-ink-900 text-sm font-bold hover:bg-ink-100 transition-colors disabled:opacity-50"
            >
              {discovering ? "جاري البحث..." : "البحث عن أجهزة مركزية"}
            </button>
            {discovered.length > 0 && (
              <div className="mt-3 space-y-1.5">
                {discovered.map((hub) => (
                  <div key={hub.addr} className="flex items-center justify-between p-2.5 rounded-sm border border-ink-100">
                    <div>
                      <p className="text-sm font-arabic text-ink-900">{hub.name}</p>
                      <p className="text-xs font-mono text-ink-400" dir="ltr">{hub.addr}</p>
                    </div>
                    <button
                      onClick={() => joinHub(hub)}
                      disabled={busy}
                      className="h-8 px-4 rounded-sm bg-saffron-600 text-white text-xs font-bold hover:bg-saffron-700 transition-colors disabled:opacity-50"
                    >
                      اتصال
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {status.mode === "satellite" && (
        <div className="bg-white rounded-md p-5 border border-ink-200 space-y-3">
          <div className="flex justify-between text-sm">
            <span className="font-arabic text-ink-400">الجهاز المركزي</span>
            <span className="font-mono text-ink-900" dir="ltr">{status.hubAddr}</span>
          </div>
          {status.paired ? (
            <p className="text-sm font-arabic text-green-700">متصل ويعمل بشكل طبيعي.</p>
          ) : (
            <p className="text-sm font-arabic text-amber-700">
              {pairingWait ? "بانتظار موافقة الجهاز المركزي..." : "لم تتم الموافقة بعد"}
            </p>
          )}
          <button
            onClick={forgetPairing}
            disabled={busy}
            className="h-9 px-4 rounded-sm bg-white border-2 border-ink-200 text-ink-900 text-xs font-bold hover:bg-ink-100 transition-colors disabled:opacity-50"
          >
            إلغاء الاتصال بهذا المركز
          </button>
        </div>
      )}

      {status.mode === "hub" && (
        <>
          {/* 2026-08-22 QA re-audit: `forget_pairing_v3` (resets
              lan_config.json's mode back to "standalone") already existed
              and was already wired to the Satellite block below -- but
              never offered here, so a device that became a Hub had no UI
              path back to standalone at all, confirmed live. Same action,
              same button copy pattern as the Satellite block's "إلغاء
              الاتصال بهذا المركز". `start_hub_server` only ever runs at
              boot or right when Hub mode is enabled (lan.rs/lib.rs) -- there
              is no live "stop the server" call anywhere in this codebase --
              so this is honest about the restart requirement rather than
              implying the change takes effect immediately. */}
          <div className="bg-white rounded-md p-5 border border-ink-200 space-y-2">
            <button
              onClick={forgetPairing}
              disabled={busy}
              className="h-9 px-4 rounded-sm bg-white border-2 border-ink-200 text-ink-900 text-xs font-bold hover:bg-ink-100 transition-colors disabled:opacity-50"
            >
              تعطيل وضع المركزي
            </button>
            <p className="text-xs text-ink-400 font-arabic">
              يعيد هذا الجهاز إلى الوضع المستقل. يسري التغيير بالكامل بعد إعادة تشغيل التطبيق.
            </p>
          </div>

          <div className="bg-white rounded-md p-5 border border-ink-200 space-y-3">
            <p className="text-sm font-arabic text-ink-900 font-bold">طلبات اتصال جديدة</p>
            {pending.length === 0 ? (
              <p className="text-sm text-ink-400 font-arabic">لا توجد طلبات بانتظار الموافقة</p>
            ) : (
              <div className="space-y-1.5">
                {pending.map((p) => (
                  <div key={p.id} className="flex items-center justify-between p-2.5 rounded-sm border border-ink-100">
                    <div>
                      <span className="text-sm font-arabic text-ink-900">{p.deviceName}</span>
                      <span className="mr-2 text-[11px] font-arabic px-2 py-0.5 rounded-full bg-ink-100 text-ink-500">{roleLabel(p.deviceRole)}</span>
                    </div>
                    <div className="flex gap-1.5">
                      <button onClick={() => approve(p.id)} className="h-8 px-4 rounded-sm bg-saffron-600 text-white text-xs font-bold hover:bg-saffron-700 transition-colors">
                        موافقة
                      </button>
                      <button onClick={() => reject(p.id)} className="h-8 px-4 rounded-sm bg-white border-2 border-ink-200 text-ink-500 text-xs font-bold hover:bg-ink-100 transition-colors">
                        رفض
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="bg-white rounded-md p-5 border border-ink-200 space-y-3">
            <p className="text-sm font-arabic text-ink-900 font-bold">الأجهزة المتصلة</p>
            {paired.length === 0 ? (
              <p className="text-sm text-ink-400 font-arabic">لا توجد أجهزة متصلة بعد</p>
            ) : (
              <div className="space-y-1.5">
                {paired.map((t) => (
                  <div key={t.id} className="flex items-center justify-between p-2.5 rounded-sm border border-ink-100">
                    <div>
                      <span className="text-sm font-arabic text-ink-900">{t.deviceName}</span>
                      <span className={`mr-2 text-[11px] font-arabic px-2 py-0.5 rounded-full ${t.status === "APPROVED" ? "bg-green-50 text-green-700" : "bg-ink-100 text-ink-500"}`}>
                        {t.status === "APPROVED" ? "متصل" : "ملغى"}
                      </span>
                      <span className="mr-1 text-[11px] font-arabic px-2 py-0.5 rounded-full bg-ink-100 text-ink-500">{roleLabel(t.deviceRole)}</span>
                    </div>
                    {t.status === "APPROVED" && (
                      <button onClick={() => revoke(t.id)} className="h-8 px-4 rounded-sm bg-white border-2 border-ink-200 text-danger text-xs font-bold hover:bg-danger-soft transition-colors">
                        إلغاء الارتباط
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
