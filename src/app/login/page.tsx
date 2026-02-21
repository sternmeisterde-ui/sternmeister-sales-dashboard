"use client";

import { useState } from "react";
import { Lock, Mail, ArrowRight, Bot } from "lucide-react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const router = useRouter();

    const handleLogin = (e: React.FormEvent) => {
        e.preventDefault();
        setIsLoading(true);
        // Имитация задержки авторизации при загрузке
        setTimeout(() => {
            setIsLoading(false);
            router.push("/");
        }, 1200);
    };

    return (
        <div className="relative min-h-screen flex items-center justify-center overflow-hidden bg-slate-950 font-sans">
            {/* Динамический фон со свечениями (Glassmorphism + Orbs) */}
            <div className="absolute top-[20%] left-[20%] w-[500px] h-[500px] bg-blue-600/20 rounded-full blur-[120px] mix-blend-screen animate-pulse" />
            <div className="absolute bottom-[20%] right-[20%] w-[400px] h-[400px] bg-emerald-500/10 rounded-full blur-[150px] mix-blend-screen animate-pulse" style={{ animationDelay: '2s' }} />
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full h-full bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-slate-900/50 via-slate-950 to-slate-950/90 -z-10" />

            {/* Центральная карточка (Glassmorphic) */}
            <div className="relative z-10 w-full max-w-md p-8 pt-10 mx-4 sm:mx-0 bg-slate-900/40 backdrop-blur-2xl rounded-[32px] border border-white/10 shadow-[0_0_80px_-20px_rgba(0,0,0,0.5)]">

                {/* Логотип */}
                <div className="flex flex-col items-center justify-center mb-10 gap-4">
                    <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-blue-500 to-emerald-400 p-[2px] shadow-lg shadow-blue-500/20">
                        <div className="w-full h-full bg-slate-950 rounded-[14px] flex items-center justify-center">
                            <Bot className="w-8 h-8 text-blue-400" />
                        </div>
                    </div>
                    <div className="text-center">
                        <h1 className="text-2xl font-black text-white tracking-tight">Sternmeister</h1>
                        <p className="text-sm font-medium text-slate-400 mt-1 uppercase tracking-widest">Dashboard AI</p>
                    </div>
                </div>

                {/* Форма авторизации */}
                <form onSubmit={handleLogin} className="flex flex-col gap-6">
                    <div className="flex flex-col gap-4">

                        {/* Input Email */}
                        <div className="relative group">
                            <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-slate-500 group-focus-within:text-blue-400 transition-colors">
                                <Mail className="w-5 h-5" />
                            </div>
                            <input
                                type="email"
                                required
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                placeholder="Рабочий Email"
                                className="w-full pl-12 pr-4 py-3.5 bg-slate-950/50 border border-white/5 rounded-2xl text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-all text-sm font-medium shadow-inner"
                            />
                        </div>

                        {/* Input Password */}
                        <div className="relative group">
                            <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-slate-500 group-focus-within:text-blue-400 transition-colors">
                                <Lock className="w-5 h-5" />
                            </div>
                            <input
                                type="password"
                                required
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                placeholder="Пароль"
                                className="w-full pl-12 pr-4 py-3.5 bg-slate-950/50 border border-white/5 rounded-2xl text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-blue-500/50 focus:ring-1 focus:ring-blue-500/50 transition-all text-sm font-medium shadow-inner"
                            />
                        </div>

                    </div>

                    {/* Кнопка войти */}
                    <button
                        type="submit"
                        disabled={isLoading}
                        className="group relative w-full flex justify-center py-3.5 px-4 rounded-2xl text-sm font-bold text-white overflow-hidden transition-all shadow-[0_0_40px_-10px_rgba(59,130,246,0.4)] hover:shadow-[0_0_60px_-15px_rgba(59,130,246,0.6)] hover:-translate-y-0.5 disabled:opacity-70 disabled:hover:translate-y-0"
                    >
                        <div className="absolute inset-0 w-full h-full bg-gradient-to-r from-blue-600 to-indigo-500" />
                        <div className="absolute inset-0 w-full h-full bg-gradient-to-r from-blue-500 to-indigo-400 opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
                        <span className="relative flex items-center gap-2">
                            {isLoading ? (
                                <>
                                    <div className="w-4 h-4 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                                    Вход в систему...
                                </>
                            ) : (
                                <>
                                    Войти
                                    <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                                </>
                            )}
                        </span>
                    </button>
                </form>

                {/* Футер */}
                <p className="mt-8 text-center text-[10px] font-bold text-slate-500/50 uppercase tracking-[0.2em]">
                    v 2.0.1 • Encrypted Connection
                </p>

            </div>
        </div>
    );
}
