"use client";

export default function DinoLoader() {
  return (
    <div className="flex flex-col items-center justify-center py-16 select-none">
      <div className="relative w-[280px] h-[160px] overflow-hidden">
        {/* Stars background */}
        {[...Array(20)].map((_, i) => (
          <div
            key={i}
            className="absolute rounded-full bg-white"
            style={{
              width: i % 3 === 0 ? 2 : 1,
              height: i % 3 === 0 ? 2 : 1,
              left: `${(i * 47 + 13) % 100}%`,
              top: `${(i * 31 + 7) % 100}%`,
              opacity: 0.3 + (i % 4) * 0.15,
              animation: `starTwinkle ${1.5 + (i % 3) * 0.5}s ease-in-out infinite`,
              animationDelay: `${i * 0.2}s`,
            }}
          />
        ))}

        {/* Planet / asteroid to orbit around */}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <div className="relative">
            {/* Planet body */}
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-500/30 to-purple-600/30 border border-blue-400/20" />
            {/* Ring */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-16 h-4 border border-blue-400/15 rounded-full -rotate-12" />
          </div>
        </div>

        {/* Rocket ship orbiting */}
        <div className="absolute left-1/2 top-1/2 animate-[rocketOrbit_4s_ease-in-out_infinite]" style={{ transformOrigin: "0 0" }}>
          <svg width="28" height="28" viewBox="0 0 28 28" className="animate-[rocketTilt_4s_ease-in-out_infinite]">
            {/* Flame */}
            <ellipse cx="14" cy="26" rx="3" ry="4" className="animate-[flamePulse_0.3s_ease-in-out_infinite]">
              <animate attributeName="fill" values="#f97316;#fbbf24;#f97316" dur="0.3s" repeatCount="indefinite" />
            </ellipse>
            <ellipse cx="14" cy="25" rx="1.5" ry="2.5" fill="#fef3c7" opacity="0.8" />
            {/* Body */}
            <path d="M14 2 L8 18 L14 22 L20 18 Z" fill="url(#rocketGrad)" />
            {/* Nose cone */}
            <ellipse cx="14" cy="4" rx="3" ry="4" fill="#60a5fa" />
            {/* Window */}
            <circle cx="14" cy="10" r="2.5" fill="#1e293b" stroke="#93c5fd" strokeWidth="0.5" />
            <circle cx="14.5" cy="9.5" r="1" fill="#60a5fa" opacity="0.5" />
            {/* Fins */}
            <path d="M8 18 L4 22 L8 20 Z" fill="#3b82f6" />
            <path d="M20 18 L24 22 L20 20 Z" fill="#3b82f6" />
            <defs>
              <linearGradient id="rocketGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#93c5fd" />
                <stop offset="100%" stopColor="#3b82f6" />
              </linearGradient>
            </defs>
          </svg>
        </div>

        {/* Trail particles */}
        <div className="absolute left-1/2 top-1/2 animate-[rocketOrbit_4s_ease-in-out_infinite]" style={{ transformOrigin: "0 0", animationDelay: "-0.3s" }}>
          <div className="w-1.5 h-1.5 rounded-full bg-orange-400/40 animate-[trailFade_0.8s_linear_infinite]" />
        </div>
        <div className="absolute left-1/2 top-1/2 animate-[rocketOrbit_4s_ease-in-out_infinite]" style={{ transformOrigin: "0 0", animationDelay: "-0.6s" }}>
          <div className="w-1 h-1 rounded-full bg-amber-400/25 animate-[trailFade_0.8s_linear_infinite]" />
        </div>
      </div>

      <span className="text-slate-500 text-sm mt-1 animate-pulse">Загрузка данных...</span>

      <style jsx>{`
        @keyframes rocketOrbit {
          0% { transform: translate(-60px, -40px) rotate(0deg); }
          25% { transform: translate(50px, -50px) rotate(0deg); }
          50% { transform: translate(60px, 30px) rotate(0deg); }
          75% { transform: translate(-50px, 40px) rotate(0deg); }
          100% { transform: translate(-60px, -40px) rotate(0deg); }
        }
        @keyframes rocketTilt {
          0% { transform: rotate(-30deg); }
          25% { transform: rotate(10deg); }
          50% { transform: rotate(40deg); }
          75% { transform: rotate(190deg); }
          100% { transform: rotate(330deg); }
        }
        @keyframes starTwinkle {
          0%, 100% { opacity: 0.2; }
          50% { opacity: 0.7; }
        }
        @keyframes flamePulse {
          0%, 100% { transform: scaleY(1); }
          50% { transform: scaleY(1.3); }
        }
        @keyframes trailFade {
          0% { opacity: 0.5; transform: scale(1); }
          100% { opacity: 0; transform: scale(0.2); }
        }
      `}</style>
    </div>
  );
}
