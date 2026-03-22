"use client";

export default function DinoLoader() {
  return (
    <div className="flex flex-col items-center justify-center py-16 select-none">
      <div className="relative w-[320px] h-[100px] overflow-hidden">
        {/* Ground line */}
        <div className="absolute bottom-[18px] left-0 right-0 h-[2px] bg-slate-700" />

        {/* Obstacles moving right to left */}
        <div className="absolute bottom-[18px] animate-[obstacleMove_3s_linear_infinite]">
          <svg width="20" height="32" viewBox="0 0 20 32" className="text-slate-600">
            <rect x="6" y="0" width="8" height="24" rx="2" fill="currentColor" />
            <rect x="0" y="8" width="6" height="4" rx="1" fill="currentColor" />
            <rect x="14" y="4" width="6" height="4" rx="1" fill="currentColor" />
          </svg>
        </div>

        <div className="absolute bottom-[18px] animate-[obstacleMove_3s_linear_infinite]" style={{ animationDelay: "-1.5s" }}>
          <svg width="16" height="20" viewBox="0 0 16 20" className="text-slate-600">
            <rect x="4" y="0" width="8" height="16" rx="2" fill="currentColor" />
            <rect x="0" y="6" width="4" height="4" rx="1" fill="currentColor" />
            <rect x="12" y="2" width="4" height="4" rx="1" fill="currentColor" />
          </svg>
        </div>

        {/* Ostrich - bouncing */}
        <div className="absolute left-[60px] bottom-[18px] animate-[dinoJump_0.6s_ease-in-out_infinite]">
          <svg width="44" height="52" viewBox="0 0 44 52" className="text-blue-400">
            {/* Body - oval */}
            <ellipse cx="18" cy="30" rx="14" ry="10" fill="currentColor" />
            {/* Tail feathers */}
            <ellipse cx="4" cy="26" rx="5" ry="4" fill="currentColor" opacity="0.7" />
            <ellipse cx="2" cy="30" rx="4" ry="3" fill="currentColor" opacity="0.5" />
            {/* Neck - long */}
            <rect x="28" y="8" width="5" height="24" rx="2.5" fill="currentColor" />
            {/* Head */}
            <ellipse cx="34" cy="7" rx="7" ry="5" fill="currentColor" />
            {/* Eye */}
            <circle cx="37" cy="6" r="2" fill="#0f172a" />
            <circle cx="37.5" cy="5.5" r="0.8" fill="white" />
            {/* Beak */}
            <polygon points="41,7 44,9 41,10" fill="#f59e0b" />
            {/* Legs - long, animated */}
            <rect className="animate-[legMove_0.2s_linear_infinite]" x="12" y="38" width="3" height="14" rx="1.5" fill="currentColor" />
            <rect className="animate-[legMove_0.2s_linear_infinite]" style={{animationDelay: "0.1s"}} x="22" y="38" width="3" height="14" rx="1.5" fill="currentColor" />
            {/* Wing */}
            <ellipse cx="16" cy="28" rx="8" ry="5" fill="currentColor" opacity="0.6" />
          </svg>
        </div>

        {/* Dust particles */}
        <div className="absolute left-[50px] bottom-[16px] animate-[dustPuff_0.6s_ease-out_infinite]">
          <div className="w-1.5 h-1.5 rounded-full bg-slate-600 opacity-60" />
        </div>
        <div className="absolute left-[45px] bottom-[20px] animate-[dustPuff_0.6s_ease-out_infinite_0.15s]">
          <div className="w-1 h-1 rounded-full bg-slate-600 opacity-40" />
        </div>
      </div>

      <span className="text-slate-500 text-sm mt-2 animate-pulse">Загрузка данных...</span>

      <style jsx>{`
        @keyframes dinoJump {
          0%, 100% { transform: translateY(0); }
          50% { transform: translateY(-30px); }
        }
        @keyframes obstacleMove {
          from { transform: translateX(320px); }
          to { transform: translateX(-40px); }
        }
        @keyframes legMove {
          0%, 100% { transform: scaleY(1); }
          50% { transform: scaleY(0.7); }
        }
        @keyframes dustPuff {
          0% { transform: translate(0, 0) scale(1); opacity: 0.6; }
          100% { transform: translate(-15px, -8px) scale(0.3); opacity: 0; }
        }
      `}</style>
    </div>
  );
}
