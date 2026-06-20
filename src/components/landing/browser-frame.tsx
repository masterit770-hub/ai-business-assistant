import Image from "next/image";
import { cn } from "@/lib/utils";

// A tasteful macOS-style browser-chrome frame for product screenshots. Rounded,
// soft-shadowed, with a faux address bar. The image is a real product capture.
export function BrowserFrame({
  src,
  alt,
  width,
  height,
  url = "nucleus-woad.vercel.app",
  className,
  priority = false,
  imgClassName,
}: {
  src: string;
  alt: string;
  width: number;
  height: number;
  url?: string;
  className?: string;
  priority?: boolean;
  imgClassName?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border border-line bg-surface shadow-lift",
        className
      )}
    >
      {/* chrome bar */}
      <div className="flex items-center gap-2 border-b border-line bg-canvas/80 px-4 py-2.5">
        <div className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-full bg-line-strong" />
          <span className="size-2.5 rounded-full bg-line-strong" />
          <span className="size-2.5 rounded-full bg-line-strong" />
        </div>
        <div className="mx-auto flex max-w-[60%] items-center gap-1.5 truncate rounded-md border border-line bg-surface px-3 py-1 text-[11px] text-faint">
          <svg viewBox="0 0 24 24" className="size-3 shrink-0 text-faint" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
          <span className="truncate">{url}</span>
        </div>
        <span className="w-12" />
      </div>
      {/* image */}
      <Image
        src={src}
        alt={alt}
        width={width}
        height={height}
        priority={priority}
        className={cn("h-auto w-full", imgClassName)}
        sizes="(max-width: 768px) 100vw, 640px"
      />
    </div>
  );
}
