import { NucleusMark } from "@/components/brand";
import { connectedSources } from "@/lib/mock";

// A central "Nucleus" node with the connected-source chips arranged around it,
// linked by faint connector lines. Pure CSS + one SVG layer for the lines.
export function SourcesOrbit() {
  // Five chips placed at fixed positions around the core (percent coords on a
  // square stage). Lines are drawn from each chip's anchor to the center.
  const nodes = [
    { x: 14, y: 14 },  // top-left
    { x: 82, y: 12 },  // top-right
    { x: 9, y: 60 },   // mid-left
    { x: 88, y: 56 },  // mid-right
    { x: 50, y: 88 },  // bottom-center
  ];

  return (
    <div className="relative mx-auto aspect-square w-full max-w-[460px]">
      {/* connector lines */}
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="absolute inset-0 size-full"
        aria-hidden
      >
        {nodes.map((n, i) => (
          <line
            key={i}
            x1={n.x}
            y1={n.y + 4}
            x2="50"
            y2="50"
            stroke="var(--color-line-strong)"
            strokeWidth="0.4"
            strokeDasharray="1.5 1.5"
          />
        ))}
      </svg>

      {/* soft halo behind the core */}
      <div className="absolute left-1/2 top-1/2 size-44 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent-soft blur-2xl" />

      {/* central Nucleus core */}
      <div className="absolute left-1/2 top-1/2 flex size-28 -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center rounded-full border border-accent-ring bg-surface shadow-card">
        <NucleusMark className="size-9" />
        <span className="mt-1 font-display text-sm font-semibold tracking-tight text-ink">
          Nucleus
        </span>
      </div>

      {/* source chips */}
      {connectedSources.map((src, i) => {
        const n = nodes[i];
        return (
          <div
            key={src.label}
            className="absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${n.x}%`, top: `${n.y}%` }}
          >
            <div className="flex flex-col items-start rounded-xl border border-line bg-surface px-3 py-2 shadow-soft">
              <span className="text-sm font-semibold text-ink">{src.label}</span>
              <span className="text-[11px] leading-tight text-faint">
                {src.hint}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
