import { useEffect, useRef, useState } from "react";
import confetti from "canvas-confetti";

// Full-screen milestone celebrations, fired when a celebration-flagged chat
// message (uiCardData.celebration) first renders. One distinct effect per
// milestone (our own implementations, inspired by classic message effects):
//
//   confetti  - "It's a match" + journey-complete handoff (side cannons + burst)
//   fireworks - a payment landed (staggered radial shell bursts across the sky)
//   balloons  - agreement fully signed (colorful balloons float up the screen)
//
// The `kind` prop is the raw uiCardData.celebration value; mapping:
//   "payment_received" -> fireworks, "agreement_signed" -> balloons,
//   anything else truthy ("match_confirmed", true) -> confetti.
//
// Guards:
//  - fires at most once per message per browser tab (module Set + sessionStorage)
//  - only for reasonably fresh messages (48h) so revisiting an old chat
//    months later doesn't replay the show
//  - respects prefers-reduced-motion (canvas-confetti flag + balloon skip)

const firedThisTab = new Set<string>();
const FRESHNESS_MS = 48 * 60 * 60 * 1000;

const BALLOON_COLORS = ["#e5484d", "#f76b15", "#ffc53d", "#30a46c", "#0090ff", "#8e4ec6", "#e93d82"];

function reducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Should this message's effect fire now? Claims the once-per-tab guard. */
function claimFire(messageId: string, createdAt?: string | null): boolean {
  if (!messageId) return false;
  if (createdAt && Date.now() - new Date(createdAt).getTime() > FRESHNESS_MS) return false;
  if (firedThisTab.has(messageId)) return false;
  const key = `celebrated-${messageId}`;
  try {
    if (sessionStorage.getItem(key)) return false;
    sessionStorage.setItem(key, "1");
  } catch { /* storage unavailable - fall back to the in-memory guard */ }
  firedThisTab.add(messageId);
  return true;
}

function fireConfetti(): () => void {
  const base = { ticks: 220, gravity: 0.9, scalar: 1.1, zIndex: 9999, disableForReducedMotion: true };
  // Two side cannons, then a center burst.
  confetti({ ...base, particleCount: 80, spread: 65, angle: 60, origin: { x: 0.15, y: 0.75 } });
  confetti({ ...base, particleCount: 80, spread: 65, angle: 120, origin: { x: 0.85, y: 0.75 } });
  const t1 = setTimeout(() => {
    confetti({ ...base, particleCount: 140, spread: 110, angle: 90, origin: { x: 0.5, y: 0.6 }, startVelocity: 45 });
  }, 300);
  const t2 = setTimeout(() => {
    confetti({ ...base, particleCount: 60, spread: 80, angle: 90, origin: { x: 0.5, y: 0.7 }, scalar: 0.9 });
  }, 700);
  return () => { clearTimeout(t1); clearTimeout(t2); };
}

// iMessage-style fireworks: the screen dims to near-black (CSS fireworks-dim
// keyframes) while a canvas runs a real show - rockets launch from the bottom
// edge with glowing trails, arc up, and burst into gravity-pulled, twinkling
// sparks drawn additively so they bloom against the dark backdrop.
const FIREWORKS_SHOW_MS = 7200;

function FireworksOverlay({ onDone }: { onDone: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) { onDone(); return; }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W = window.innerWidth;
    const H = window.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);

    // Firework hues: gold, red, azure, green, pink, purple, cyan.
    const HUES = [45, 0, 210, 130, 320, 275, 190];
    type Spark = { x: number; y: number; vx: number; vy: number; life: number; maxLife: number; hue: number; size: number; twinkle: boolean };
    type Rocket = { x: number; y: number; vx: number; vy: number; targetY: number; hue: number; big: boolean };
    const sparks: Spark[] = [];
    const rockets: Rocket[] = [];

    const launch = (big: boolean) => {
      rockets.push({
        x: W * (0.15 + Math.random() * 0.7),
        y: H + 8,
        vx: (Math.random() - 0.5) * 1.4,
        vy: -(H * 0.014 + Math.random() * H * 0.004),
        targetY: H * (0.12 + Math.random() * 0.32),
        hue: HUES[Math.floor(Math.random() * HUES.length)],
        big,
      });
    };

    const explode = (r: Rocket) => {
      const count = r.big ? 110 : 70;
      // ~1/3 of shells are two-tone, alternating spark colors.
      const hue2 = Math.random() < 0.35 ? HUES[Math.floor(Math.random() * HUES.length)] : r.hue;
      for (let i = 0; i < count; i++) {
        const angle = (Math.PI * 2 * i) / count + Math.random() * 0.08;
        const speed = (r.big ? 5.6 : 4.1) * (0.35 + Math.random() * 0.75);
        sparks.push({
          x: r.x, y: r.y,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 0,
          maxLife: 60 + Math.random() * 38,
          hue: i % 2 === 0 ? r.hue : hue2,
          size: r.big ? 2.4 : 1.9,
          twinkle: Math.random() < 0.4,
        });
      }
    };

    // The show: a rocket roughly every 400ms for ~4.5s, with occasional
    // double launches, then the last bursts fade as the dim releases.
    const timers: ReturnType<typeof setTimeout>[] = [];
    timers.push(setTimeout(() => launch(true), 250));
    [650, 1000, 1350, 1750, 2100, 2450, 2850, 3250, 3650, 4050, 4450].forEach((ms, i) => {
      timers.push(setTimeout(() => { launch(i % 3 === 0); if (i % 4 === 2) launch(false); }, ms));
    });

    let raf = 0;
    let running = true;
    const step = () => {
      if (!running) return;
      // Fade the previous frame instead of clearing - this is what leaves
      // the glowing trails (transparent-canvas trail technique).
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "rgba(0, 0, 0, 0.22)";
      ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = "lighter";

      for (let i = rockets.length - 1; i >= 0; i--) {
        const r = rockets[i];
        r.x += r.vx;
        r.y += r.vy;
        r.vy += 0.055; // gravity decelerates the climb
        ctx.beginPath();
        ctx.fillStyle = `hsla(${r.hue}, 100%, 78%, 0.95)`;
        ctx.arc(r.x, r.y, 1.7, 0, Math.PI * 2);
        ctx.fill();
        if (r.y <= r.targetY || r.vy > -2) { explode(r); rockets.splice(i, 1); }
      }

      for (let i = sparks.length - 1; i >= 0; i--) {
        const p = sparks[i];
        p.life++;
        const t = p.life / p.maxLife;
        if (t >= 1) { sparks.splice(i, 1); continue; }
        p.vx *= 0.985;
        p.vy = p.vy * 0.985 + 0.048; // drag + gravity pull the sparks down
        p.x += p.vx;
        p.y += p.vy;
        let alpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
        if (p.twinkle && t > 0.5 && Math.random() < 0.25) alpha *= 0.3; // strobe near burnout
        ctx.beginPath();
        ctx.fillStyle = `hsla(${p.hue}, 100%, ${60 + 25 * (1 - t)}%, ${alpha})`;
        ctx.arc(p.x, p.y, p.size * (1 - t * 0.5), 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);

    const end = setTimeout(onDone, FIREWORKS_SHOW_MS);
    return () => {
      running = false;
      cancelAnimationFrame(raf);
      timers.forEach(clearTimeout);
      clearTimeout(end);
    };
  }, [onDone]);

  return (
    <div className="fixed inset-0 pointer-events-none" style={{ zIndex: 9999 }} data-testid="fireworks-overlay">
      <div className="absolute inset-0 bg-black" style={{ animation: `fireworks-dim ${FIREWORKS_SHOW_MS}ms ease-in-out forwards` }} />
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
    </div>
  );
}

/** One balloon: oval body with a highlight, knot, and a wavy string. */
function Balloon({ color, left, delay, duration, size, drift }: {
  color: string; left: number; delay: number; duration: number; size: number; drift: number;
}) {
  return (
    <div
      className="absolute bottom-0 will-change-transform"
      style={{
        left: `${left}%`,
        animation: `balloon-rise ${duration}s cubic-bezier(0.25, 0.1, 0.25, 1) ${delay}s forwards`,
        transform: "translateY(30vh)",
        ["--balloon-drift" as any]: `${drift}px`,
      }}
    >
      <div style={{ animation: `balloon-sway ${2.2 + (size % 3) * 0.4}s ease-in-out ${delay}s infinite alternate` }}>
        <svg width={size} height={size * 1.55} viewBox="0 0 60 93" fill="none" aria-hidden>
          <ellipse cx="30" cy="27" rx="26" ry="30" fill={color} />
          <ellipse cx="21" cy="17" rx="8" ry="11" fill="white" opacity="0.35" transform="rotate(-20 21 17)" />
          <path d="M27 56 L30 61 L33 56 Z" fill={color} />
          <path d="M30 61 C 24 68, 36 74, 30 81 C 26 86, 33 90, 30 93" stroke={color} strokeWidth="1.6" fill="none" opacity="0.8" />
        </svg>
      </div>
    </div>
  );
}

function BalloonsOverlay({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 8000);
    return () => clearTimeout(t);
  }, [onDone]);
  const balloons = Array.from({ length: 12 }, (_, i) => ({
    color: BALLOON_COLORS[i % BALLOON_COLORS.length],
    left: 4 + ((i * 8.3 + (i % 3) * 5) % 88),
    delay: (i % 6) * 0.35,
    duration: 4.6 + (i % 5) * 0.55,
    size: 44 + (i % 4) * 8,
    drift: ((i % 2 === 0 ? 1 : -1) * (14 + (i % 5) * 6)),
  }));
  return (
    <div className="fixed inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 9999 }} data-testid="balloons-overlay">
      {balloons.map((b, i) => <Balloon key={i} {...b} />)}
    </div>
  );
}

export function CelebrationBurst({ messageId, createdAt, kind }: {
  messageId: string;
  createdAt?: string | null;
  /** Raw uiCardData.celebration value - picks the effect. */
  kind?: string | boolean;
}) {
  const [showBalloons, setShowBalloons] = useState(false);
  const [showFireworks, setShowFireworks] = useState(false);

  useEffect(() => {
    const effect = kind === "payment_received" ? "fireworks" : kind === "agreement_signed" ? "balloons" : "confetti";
    if ((effect === "balloons" || effect === "fireworks") && reducedMotion()) return;
    if (!claimFire(messageId, createdAt)) return;
    if (effect === "fireworks") { setShowFireworks(true); return; }
    if (effect === "balloons") { setShowBalloons(true); return; }
    return fireConfetti();
  }, [messageId, createdAt, kind]);

  if (showFireworks) return <FireworksOverlay onDone={() => setShowFireworks(false)} />;
  if (showBalloons) return <BalloonsOverlay onDone={() => setShowBalloons(false)} />;
  return null;
}
