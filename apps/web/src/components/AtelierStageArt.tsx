import { useId } from "react";

// Atelier fork identity art: bordeaux leather with a brass stitch, matching the app icon.
// The palette is fixed rather than themed, like the icon itself.
const LEATHER_TOP = "#8a2a3a";
const LEATHER_MID = "#5e1a28";
const LEATHER_BOTTOM = "#3a0c17";
const GLOW = "#e0a868";
const BRASS = "#d8b47a";
const SHADOW = "#1c0409";

const GRAIN: ReadonlyArray<{ x: number; y: number; r: number; light: boolean }> = [
  { x: 3, y: 4, r: 0.5, light: true },
  { x: 11, y: 2, r: 0.4, light: false },
  { x: 17, y: 9, r: 0.6, light: true },
  { x: 7, y: 13, r: 0.45, light: false },
  { x: 21, y: 17, r: 0.4, light: true },
  { x: 2, y: 20, r: 0.5, light: false },
  { x: 13, y: 21, r: 0.35, light: true },
];

export function AtelierStageArt({ compact = false }: { compact?: boolean }) {
  const idPrefix = useId().replaceAll(":", "");
  const leatherId = `${idPrefix}-stage-atelier-leather`;
  const glowId = `${idPrefix}-stage-atelier-glow`;
  const glowsId = `${idPrefix}-stage-atelier-glows`;
  const grainId = `${idPrefix}-stage-atelier-grain`;

  return (
    <svg
      data-stage-art="atelier"
      className="h-full w-full"
      fill="none"
      preserveAspectRatio="xMinYMin slice"
      viewBox={compact ? "40 0 8192 96" : "0 0 8192 96"}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient
          id={leatherId}
          x1="40"
          y1="0"
          x2="200"
          y2="96"
          gradientUnits="userSpaceOnUse"
          spreadMethod="reflect"
        >
          <stop stopColor={LEATHER_TOP} />
          <stop offset="0.5" stopColor={LEATHER_MID} />
          <stop offset="1" stopColor={LEATHER_BOTTOM} />
        </linearGradient>
        <radialGradient
          id={glowId}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(220 10) rotate(140) scale(130 80)"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor={GLOW} stopOpacity="0.3" />
          <stop offset="1" stopColor={GLOW} stopOpacity="0" />
        </radialGradient>
        <pattern id={glowsId} width="720" height="96" patternUnits="userSpaceOnUse">
          <rect width="720" height="96" fill={`url(#${glowId})`} />
        </pattern>
        <pattern id={grainId} width="24" height="24" patternUnits="userSpaceOnUse">
          {GRAIN.map((speck) => (
            <circle
              key={`${speck.x}-${speck.y}`}
              cx={speck.x}
              cy={speck.y}
              r={speck.r}
              fill={speck.light ? "#ffffff" : "#000000"}
              fillOpacity={speck.light ? 0.06 : 0.14}
            />
          ))}
        </pattern>
      </defs>

      <rect width="100%" height="96" fill={`url(#${leatherId})`} />
      <rect width="100%" height="96" fill={`url(#${glowsId})`} />
      <rect width="100%" height="96" fill={`url(#${grainId})`} />

      <g strokeLinecap="round" strokeWidth="1.4" strokeDasharray="6 4.5">
        <path d="M0 11.2H8192" stroke={SHADOW} strokeOpacity="0.55" />
        <path d="M0 10H8192" stroke={BRASS} strokeOpacity="0.9" />
      </g>
    </svg>
  );
}
