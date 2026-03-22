"use client";

import { useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username }),
      });

      const data = (await res.json()) as { error?: string };

      if (!res.ok) {
        setError(data.error ?? "Ошибка входа");
        return;
      }

      router.push("/");
    } catch {
      setError("Не удалось подключиться к серверу");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <style>{`
        @keyframes gradientShift {
          0%   { background-position: 0% 50%; }
          50%  { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        .animated-gradient {
          background: linear-gradient(
            135deg,
            #0f172a 0%,
            #1e1b4b 25%,
            #0f172a 50%,
            #172554 75%,
            #0f172a 100%
          );
          background-size: 400% 400%;
          animation: gradientShift 12s ease infinite;
        }
      `}</style>

      <div className="animated-gradient relative min-h-screen overflow-hidden flex items-center justify-center p-4 font-sans">
        {/* Glow orbs for depth */}
        <div className="pointer-events-none absolute top-1/4 left-1/4 h-[500px] w-[500px] rounded-full bg-blue-600/15 blur-[120px]" />
        <div className="pointer-events-none absolute bottom-1/4 right-1/4 h-[400px] w-[400px] rounded-full bg-indigo-500/10 blur-[150px]" />

        {/* Card */}
        <div className="relative z-10 w-full max-w-sm rounded-[28px] border border-white/10 bg-slate-900/50 p-8 pt-10 shadow-[0_0_80px_-20px_rgba(0,0,0,0.6)] backdrop-blur-2xl">
          {/* Logo + title */}
          <div className="mb-10 flex flex-col items-center gap-4">
            <Image
              src="/logo.png"
              alt="Sternmeister logo"
              width={64}
              height={64}
              className="rounded-xl"
              priority
            />
            <div className="text-center">
              <h1 className="text-2xl font-black tracking-tight text-white">
                Sternmeister
              </h1>
              <p className="mt-1 text-xs font-medium uppercase tracking-widest text-slate-400">
                Dashboard
              </p>
            </div>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="flex flex-col gap-5">
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="username"
                className="text-sm font-medium text-slate-300"
              >
                Telegram Username
              </label>
              <div className="relative">
                <span className="absolute left-4 top-1/2 -translate-y-1/2 text-sm font-medium text-slate-500 pointer-events-none">@</span>
                <input
                  id="username"
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value.replace(/^@/, ""))}
                  placeholder="username"
                  autoComplete="username"
                  autoFocus
                  required
                  disabled={loading}
                  className="w-full rounded-2xl border border-white/5 bg-slate-950/50 pl-8 pr-4 py-3.5 text-sm font-medium text-slate-200 shadow-inner outline-none placeholder:text-slate-500 transition-all focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 disabled:opacity-50"
                />
              </div>
            </div>

            {error && (
              <p className="rounded-xl border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-400">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading || !username.trim()}
              className="group relative w-full overflow-hidden rounded-2xl py-3.5 text-sm font-bold text-white shadow-[0_0_40px_-10px_rgba(59,130,246,0.4)] transition-all hover:-translate-y-0.5 hover:shadow-[0_0_60px_-15px_rgba(59,130,246,0.6)] disabled:cursor-not-allowed disabled:opacity-70 disabled:hover:translate-y-0"
            >
              <div className="absolute inset-0 bg-gradient-to-r from-blue-600 to-indigo-500" />
              <div className="absolute inset-0 bg-gradient-to-r from-blue-500 to-indigo-400 opacity-0 transition-opacity duration-300 group-hover:opacity-100" />
              <span className="relative flex items-center justify-center gap-2">
                {loading ? (
                  <>
                    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                    Вход в систему...
                  </>
                ) : (
                  "Войти"
                )}
              </span>
            </button>
          </form>

          <p className="mt-8 text-center text-[10px] font-bold uppercase tracking-[0.2em] text-slate-500/50">
            v 2.1.0 • Secure Connection
          </p>
        </div>
      </div>
    </>
  );
}
