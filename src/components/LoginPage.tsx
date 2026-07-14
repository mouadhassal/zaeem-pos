import { useState, useEffect, useRef } from "react";
import { useAuthStore } from "../stores/authStore";
import { Eye, EyeOff, UtensilsCrossed, Lock, User, AlertCircle } from "lucide-react";

const quickLogins = [
  { role: "OWNER", label: "المدير", username: "owner", color: "bg-emerald-600" },
  { role: "MANAGER", label: "المشرف", username: "manager", color: "bg-blue-600" },
  { role: "CASHIER", label: "الكاشير", username: "cashier", color: "bg-amber-600" },
  { role: "KITCHEN", label: "المطبخ", username: "kitchen", color: "bg-rose-600" },
];

export default function LoginPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [focusedField, setFocusedField] = useState<"none" | "username" | "password">("none");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const loginWithRust = useAuthStore((s) => s.loginWithRust);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const particles: { x: number; y: number; vx: number; vy: number; size: number; opacity: number }[] = [];
    for (let i = 0; i < 30; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        size: Math.random() * 2 + 1,
        opacity: Math.random() * 0.3 + 0.05,
      });
    }

    let animationId: number;
    function animate() {
      if (!ctx || !canvas) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const p of particles) {
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
        if (p.y < 0 || p.y > canvas.height) p.vy *= -1;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(16, 185, 129, ${p.opacity})`;
        ctx.fill();
      }
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 150) {
            ctx.beginPath();
            ctx.moveTo(particles[i].x, particles[i].y);
            ctx.lineTo(particles[j].x, particles[j].y);
            ctx.strokeStyle = `rgba(16, 185, 129, ${0.05 * (1 - dist / 150)})`;
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }
      }
      animationId = requestAnimationFrame(animate);
    }
    animate();

    const handleResize = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    window.addEventListener("resize", handleResize);
    return () => {
      cancelAnimationFrame(animationId);
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);
    const err = await loginWithRust(username, password);
    if (err) setError(err);
    setLoading(false);
  }

  function quickLogin(uname: string) {
    setUsername(uname);
    setPassword("admin123");
    setTimeout(() => {
      (document.getElementById("login-form") as HTMLFormElement)?.requestSubmit();
    }, 300);
  }

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-slate-50" dir="rtl">
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />

      <div className="relative z-10 min-h-screen flex items-center justify-center p-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-lg bg-emerald-600 mb-4">
              <UtensilsCrossed className="w-8 h-8 text-white" />
            </div>
            <h1 className="text-3xl font-bold text-slate-800 mb-2 tracking-tight">
              زعيم <span className="text-emerald-600">Zaeem</span>
            </h1>
            <p className="text-slate-400 text-sm">نظام إدارة المطاعم المتكامل</p>
          </div>

          <div className="bg-white border border-slate-200 rounded-md p-8 shadow-sm">
            {error && (
              <div className="mb-6 flex items-center gap-2 p-3 rounded-sm bg-red-50 border border-red-200 text-red-600 text-sm">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <form id="login-form" onSubmit={handleSubmit} className="space-y-5">
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700 flex items-center gap-2">
                  <User className="w-4 h-4 text-slate-400" />
                  اسم المستخدم
                </label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  onFocus={() => setFocusedField("username")}
                  onBlur={() => setFocusedField("none")}
                  placeholder="أدخل اسم المستخدم"
                  className={`w-full h-11 px-4 rounded-sm border text-slate-800 placeholder:text-slate-400 text-right transition-colors outline-none ${
                    focusedField === "username" ? "border-emerald-500 ring-1 ring-emerald-500/20" : "border-slate-300 hover:border-slate-400"
                  }`}
                  dir="rtl"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700 flex items-center gap-2">
                  <Lock className="w-4 h-4 text-slate-400" />
                  كلمة المرور
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onFocus={() => setFocusedField("password")}
                    onBlur={() => setFocusedField("none")}
                    placeholder="••••••••"
                    className={`w-full h-11 px-4 pl-10 rounded-sm border text-slate-800 placeholder:text-slate-400 text-right transition-colors outline-none ${
                      focusedField === "password" ? "border-emerald-500 ring-1 ring-emerald-500/20" : "border-slate-300 hover:border-slate-400"
                    }`}
                    dir="rtl"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute left-3 top-1/2 -translate-y-1/2 p-1 rounded-sm text-slate-400 hover:text-slate-600 transition-colors"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={loading || !username || !password}
                className={`w-full h-11 rounded-sm font-bold text-white text-base transition-colors flex items-center justify-center gap-2 ${
                  loading || !username || !password
                    ? "bg-slate-300 cursor-not-allowed text-slate-500"
                    : "bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800"
                }`}
              >
                {loading ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    <span>جاري الدخول...</span>
                  </>
                ) : (
                  <span>تسجيل الدخول</span>
                )}
              </button>
            </form>

            <div className="my-6 flex items-center gap-3">
              <div className="flex-1 h-px bg-slate-200" />
              <span className="text-xs text-slate-400 font-medium">أو الدخول السريع</span>
              <div className="flex-1 h-px bg-slate-200" />
            </div>

            <div className="grid grid-cols-2 gap-2">
              {quickLogins.map((login) => (
                <button
                  key={login.username}
                  onClick={() => quickLogin(login.username)}
                  className="flex items-center gap-3 px-3 py-3 rounded-sm border border-slate-200 hover:border-slate-300 hover:bg-slate-50 transition-colors"
                >
                  <div className={`w-7 h-7 rounded-sm flex items-center justify-center text-white text-xs font-bold shrink-0 ${login.color}`}>
                    {login.label[0]}
                  </div>
                  <div className="text-right flex-1 min-w-0">
                    <div className="text-sm font-medium text-slate-700">{login.label}</div>
                    <div className="text-xs text-slate-400">{login.username}</div>
                  </div>
                </button>
              ))}
            </div>

            <div className="mt-5 text-center">
              <p className="text-xs text-slate-400">
                كلمة المرور الافتراضية: <span className="text-emerald-600 font-mono font-medium">admin123</span>
              </p>
            </div>
          </div>

          <div className="mt-6 text-center">
            <p className="text-xs text-slate-400">Zaeem Restaurant System v1.0.0</p>
            <p className="text-xs text-slate-400 mt-1">© 2026 Wenzdes. جميع الحقوق محفوظة.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
