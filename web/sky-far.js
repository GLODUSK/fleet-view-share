// Fleet View web: the map's deep-space events (Henry, 2026-10-14: "do all of these events and make sure we keep track of
// them so i can point out 'hey what was that?' at the specific time so we can get rid of them ... nothing too close to
// the nodes that its in my face, more like BG happening").
//
// The catalog only: every kind of far event as a name, the label and one line the log shows ("what was that?"), and a
// recipe that lays it out. map.js runs them (FAR_*: the director, where one goes, its light over time, the shader that
// draws it, the log). A recipe make(R) gets R = { r() 0-1, in(lo, hi), pick(list), sg() +1 or -1 } and returns
// { ms, quick?, parts: [...] }: ms its whole life, quick when something in it is fast enough to need every refresh,
// and up to FAR_N parts, each one shape the shader draws:
//   f      the shape (FORM below)
//   x, y   its middle off the event's middle (CSS px; to: [x, y] moves it there over its life, straight)
//   r0, r1 its size (CSS px) at the start and end of its life (eased out)
//   a      its brightest alpha (0-1); everything here is far away: small and faint, never in the way
//   t0, t1 the share of the event's life it shows in (0-1)
//   env    its light over that life: 'smooth' (in and out), 'flash' (a fast rise, rise; an exponential fall, tau),
//          'pulse' (blips every per ms over floor), 'rise' (switching on), 'fade' (dying away), 'dip' (dims once in the
//          middle), 'flicker' (a flash that wavers)
//   rgb    its colour (0-1); ang its turn (radians), spin how fast that turns (radians/s)
//   p      the shape's own number (FORM says which); u0, u1 the shape's progress over its life (a binary's inspiral, a
//          ripple's front, the knots in a jet); grow: an arc that grows from its start (a trail)
// Sizes are in proportion to each other at a 900 px window: map.js scales each event up to the window, by a pick so
// they differ, and holds the whole between 9% and 20% of the window's shorter side from its middle (FAR_SIZE,
// FAR_REACH_K); it also brightens them a little (FAR_GAIN), and lengthens their ms (FAR_LIFE).
// Alphas are kept low on purpose, and only the cosmic washes are big, at a few percent alpha.

// the shapes (the shader's farPart, map.js FAR_GLSL), with what p means for each
export const FORM = {
  point: 1, // a star-like point and its halo; p: diffraction spikes (0-1)
  ring: 2, // an expanding shell, lumpy round its edge; p: its width (share of its radius)
  jets: 3, // two opposed beams with knots running out; p: their width
  galaxy: 4, // p > 0: a spiral seen at that aspect; p < 0: an elliptical at aspect -p
  arc: 5, // a thin trail (stars along it) one radius long, bent by p (1 / radii)
  binary: 6, // two points spiralling in (u: 0 far apart, 1 merged); p: the second's light
  swirl: 7, // a one-armed spiral of debris winding into a dark middle (u turns it)
  wash: 8, // a soft, mottled glow over a disc; p: mottle cells per radius
  web: 9, // filaments (the edges of cells); p: cells per radius
  arcs: 10, // an Einstein ring cut into p arcs (1: whole, 4: a cross)
  ripple: 11, // rings running out from the middle (u: the front); p: wavelength (radii)
  dots: 12, // a swarm of faint points; p: their density (0-1)
  dark: 13, // a dark disc with a soft edge (a shadow, a hollow)
};
const F = FORM;

// colours
const WHITE = [1, 0.97, 0.92], ICE = [0.82, 0.9, 1], BLUE = [0.6, 0.74, 1], GOLD = [1, 0.82, 0.52], ORANGE = [1, 0.62, 0.34];
const RED = [1, 0.42, 0.34], VIOLET = [0.74, 0.58, 1], TEAL = [0.46, 0.9, 0.86], ROSE = [1, 0.56, 0.72], DUST = [0.86, 0.76, 0.64];

// a few building blocks
const host = (R, o = {}) => ({ f: F.galaxy, r0: o.r || R.in(14, 22), r1: o.r1, a: o.a || 0.32, rgb: o.rgb || DUST, ang: R.in(0, 6.28),
  p: o.ell ? -R.in(0.45, 0.8) : R.in(0.3, 0.75), spin: o.spin || 0.004 * R.sg(), x: o.x || 0, y: o.y || 0, to: o.to, env: 'smooth', t0: o.t0 || 0, t1: o.t1 || 1, fin: 0.12, fout: 0.15 });
// a point somewhere in a host's disc
const inHost = (R, s = 7) => [R.in(-s, s), R.in(-s * 0.6, s * 0.6)];
const flash = (R, o) => ({ f: F.point, env: 'flash', r0: 6, a: 0.85, rgb: WHITE, rise: 0.06, tau: 0.25, p: 0, ...o });
const blink = (o) => ({ f: F.point, env: 'flash', rise: 0.15, tau: 0.2, r0: 7, a: 1, rgb: WHITE, p: 0.6, ...o });
const shell = (R, o) => ({ f: F.ring, env: 'fade', r0: 2, r1: 10, a: 0.22, rgb: ORANGE, p: 0.22, ang: R.in(0, 6.28), ...o });
const binary = (R, o) => ({ f: F.binary, env: 'smooth', fin: 0.1, fout: 0.02, r0: 12, a: 0.6, rgb: ICE, p: 0.8, u0: 0, u1: 1, ...o });
const ripple = (R, o) => ({ f: F.ripple, env: 'smooth', r0: 46, a: 0.12, rgb: ICE, p: 0.14, u0: 0, u1: 1, ...o });
const dots = (R, o) => ({ f: F.dots, env: 'smooth', r0: 26, a: 0.42, rgb: ICE, p: 0.35, ...o });
const wash = (R, o) => ({ f: F.wash, env: 'smooth', r0: 40, a: 0.07, rgb: GOLD, p: 2.5, ...o });

// name -> { label, what, group, make(R) }; the order is the one in Henry's list
const K = [];
const kind = (name, label, what, group, make) => K.push([name, { label, what, group, make }]);

// ---- 1. star explosions and star deaths ----
kind('supernova', 'Core-collapse supernova', 'a massive star\'s core collapsed and blew the star apart, in a far galaxy', 'stars', (R) => {
  const [x, y] = inHost(R);
  return { ms: 26e3, parts: [host(R), flash(R, { x, y, tau: 0.3, p: 0.3 }), shell(R, { x, y, t0: 0.18 })] };
});
kind('type-ia', 'Type Ia supernova', 'a white dwarf passed 1.4 suns and blew itself apart (the standard candle)', 'stars', (R) => {
  const [x, y] = inHost(R);
  return { ms: 24e3, parts: [host(R, { ell: true }), flash(R, { x, y, rgb: ICE, rise: 0.2, tau: 0.35, p: 0.2 })] };
});
kind('hypernova', 'Hypernova', 'a supernova ten times stronger than usual, with jets', 'stars', (R) => {
  const [x, y] = inHost(R), ang = R.in(0, 6.28);
  return { ms: 22e3, parts: [host(R), { f: F.jets, x, y, r0: 14, a: 0.4, rgb: ICE, ang, p: 0.07, env: 'fade', t1: 0.3, u0: 0, u1: 1 },
    flash(R, { x, y, r0: 7, a: 0.95, p: 0.45 }), shell(R, { x, y, t0: 0.15, r1: 12 })] };
});
kind('superluminous', 'Superluminous supernova', '10 to 100 times brighter than a normal supernova, maybe powered by a newborn magnetar', 'stars', (R) => (
  { ms: 40e3, parts: [host(R, { r: 8, a: 0.22 }), flash(R, { x: R.in(-3, 3), y: R.in(-2, 2), r0: 8, a: 0.9, rgb: BLUE, rise: 0.3, tau: 0.5, p: 0.3 })] }));
kind('pair-instability', 'Pair-instability supernova', 'a star of 130-250 suns destroyed completely, leaving nothing behind', 'stars', (R) => (
  { ms: 45e3, parts: [host(R, { r: 10, a: 0.2 }), flash(R, { r0: 9, a: 0.85, rgb: GOLD, rise: 0.35, tau: 0.6, p: 0.2 }), shell(R, { t0: 0.3, r1: 16, a: 0.18 })] }));
kind('failed-supernova', 'Failed supernova', 'a massive red star collapsed straight into a black hole and simply vanished', 'stars', (R) => (
  { ms: 20e3, parts: [host(R, { a: 0.25 }), { f: F.point, x: R.in(-6, 6), y: R.in(-3, 3), r0: 4, a: 0.65, rgb: RED, env: 'dip', p: 0, t1: 0.75, fin: 0.1, fout: 0.45 }] }));
kind('impostor', 'Supernova impostor', 'a huge eruption the star survived (it flickers instead of exploding)', 'stars', (R) => {
  const [x, y] = inHost(R);
  return { ms: 22e3, parts: [host(R), { f: F.point, x, y, r0: 5, a: 0.7, rgb: GOLD, env: 'pulse', per: 2600, floor: 0.25 }] };
});
kind('calcium-rich', 'Calcium-rich transient', 'a faint, fast blast far outside its galaxy (maybe a white dwarf kicked out)', 'stars', (R) => {
  const s = R.sg();
  return { ms: 14e3, parts: [host(R, { x: -14 * s }), flash(R, { x: 18 * s, y: R.in(-8, 8), r0: 4, a: 0.6, rgb: ORANGE, rise: 0.08, tau: 0.18 })] };
});
kind('recurrent-nova', 'Recurrent nova', 'a white dwarf stealing gas flashes again and again (one in Andromeda does it every year)', 'stars', (R) => {
  const [x, y] = inHost(R, 9);
  return { ms: 22e3, parts: [host(R, { r: 22, a: 0.28 }), { f: F.point, x, y, r0: 4, a: 0.75, rgb: ICE, env: 'pulse', per: 6500, floor: 0 }] };
});
kind('red-nova', 'Luminous red nova', 'two stars spiralled together and merged into one', 'stars', (R) => {
  const [x, y] = inHost(R);
  return { ms: 24e3, parts: [host(R), binary(R, { x, y, r0: 6, t1: 0.4, a: 0.5, rgb: GOLD }),
    flash(R, { x, y, t0: 0.38, r0: 5, a: 0.7, rgb: RED, rise: 0.2, tau: 0.5 })] };
});

// ---- 2. compact object collisions ----
kind('kilonova', 'Kilonova', 'two neutron stars collided: a gamma flash, then a red glow of fresh gold and platinum', 'collisions', (R) => (
  { ms: 26e3, quick: true, parts: [host(R, { ell: true, x: R.in(-10, 10), y: R.in(-6, 6), a: 0.24 }), binary(R, { t1: 0.36 }),
    ripple(R, { t0: 0.3, t1: 0.62 }), blink({ t0: 0.35, t1: 0.42, r0: 6 }), flash(R, { t0: 0.37, r0: 5, a: 0.6, rgb: RED, rise: 0.08, tau: 0.4 })] }));
kind('ns-bh', 'Neutron star + black hole merger', 'a black hole swallowed a neutron star (gravitational waves, sometimes a faint flash)', 'collisions', (R) => (
  { ms: 16e3, parts: [binary(R, { t1: 0.55, p: 0.35, rgb: VIOLET, a: 0.45 }), ripple(R, { t0: 0.45, t1: 0.9 }),
    ...(R.r() < 0.5 ? [flash(R, { t0: 0.54, r0: 4, a: 0.45, rgb: RED, tau: 0.3 })] : [])] }));
kind('bh-merger', 'Black hole merger', 'two black holes spiralled together; spacetime rang with gravitational waves', 'collisions', (R) => (
  { ms: 15e3, parts: [binary(R, { t1: 0.55, p: 1, rgb: VIOLET, a: 0.4 }), ripple(R, { t0: 0.5, t1: 1, r0: 52, a: 0.14 })] }));
kind('mass-gap', 'Mass-gap black hole merger', 'a merger that made a black hole of a size once thought impossible (like GW190521)', 'collisions', (R) => (
  { ms: 16e3, parts: [binary(R, { t1: 0.5, p: 0.85, rgb: GOLD, a: 0.45, r0: 15 }), ripple(R, { t0: 0.45, t1: 1, r0: 64, a: 0.15, rgb: GOLD, p: 0.18 })] }));
kind('merger-grb', 'Long burst from a merger', 'a long gamma-ray burst from a neutron-star merger, with a kilonova after (GRB 211211A)', 'collisions', (R) => {
  const ang = R.in(0, 6.28);
  return { ms: 24e3, quick: true, parts: [binary(R, { t1: 0.3 }), { f: F.jets, r0: 16, a: 0.4, rgb: ICE, ang, p: 0.06, env: 'fade', t0: 0.3, t1: 0.5, u0: 0, u1: 1 },
    blink({ t0: 0.3, t1: 0.4 }), flash(R, { t0: 0.36, r0: 5, a: 0.55, rgb: RED, tau: 0.4 })] };
});

// ---- 3. gamma-ray bursts and high-energy flashes ----
kind('long-grb', 'Long gamma-ray burst', 'a dying massive star fired a jet straight at us; then the afterglow', 'flashes', (R) => (
  { ms: 16e3, quick: true, parts: [host(R, { r: 9, a: 0.18 }), blink({ t1: 0.16, r0: 8, p: 0.7 }),
    { f: F.jets, r0: 18, a: 0.35, rgb: ICE, ang: R.in(0, 6.28), p: 0.05, env: 'fade', t1: 0.22, u0: 0, u1: 1 }, flash(R, { t0: 0.08, r0: 5, a: 0.5, rgb: GOLD, rise: 0.05, tau: 0.3 })] }));
kind('short-grb', 'Short gamma-ray burst', 'a flash under two seconds, usually two neutron stars merging', 'flashes', (R) => (
  { ms: 8e3, quick: true, parts: [blink({ t1: 0.08, r0: 6 }), flash(R, { t0: 0.04, r0: 4, a: 0.35, rgb: GOLD, tau: 0.3 })] }));
kind('orphan-afterglow', 'Orphan afterglow', 'the fading glow of a gamma-ray burst whose jet pointed away from us', 'flashes', (R) => (
  { ms: 20e3, parts: [flash(R, { r0: 5, a: 0.45, rgb: GOLD, rise: 0.3, tau: 0.45 })] }));
kind('magnetar-flare', 'Magnetar giant flare', 'a starquake on a magnetar: a tenth of a second, then a ringing pulse', 'flashes', (R) => (
  { ms: 14e3, quick: true, parts: [host(R, { a: 0.22 }), blink({ x: R.in(-6, 6), y: R.in(-3, 3), t1: 0.05, r0: 6, rgb: [0.9, 0.86, 1] }),
    { f: F.point, r0: 3, a: 0.4, rgb: VIOLET, env: 'pulse', per: 1500, floor: 0, t0: 0.06, t1: 0.75 }] }));
kind('lfbot', 'Fast blue optical transient', 'a hot blue flash that rises in days and fades fast (like AT2018cow, "the Cow")', 'flashes', (R) => (
  { ms: 11e3, parts: [host(R, { r: 9, a: 0.18 }), flash(R, { x: R.in(-3, 3), r0: 5, a: 0.75, rgb: BLUE, rise: 0.05, tau: 0.15 })] }));
kind('ulx', 'Ultraluminous X-ray source', 'a neutron star or black hole eating gas faster than should be possible', 'flashes', (R) => {
  const [x, y] = inHost(R);
  return { ms: 18e3, parts: [host(R), { f: F.point, x, y, r0: 4, a: 0.55, rgb: TEAL, env: 'flicker', rise: 0.15, tau: 0.6 }] };
});

// ---- 4. supermassive black hole events ----
kind('tde', 'Tidal disruption event', 'a star strayed too close to a giant black hole and was torn into a spiral', 'black holes', (R) => {
  const s = R.sg();
  return { ms: 30e3, parts: [host(R, { r: 20, a: 0.2 }), { f: F.point, x: 16 * s, y: -6, to: [0, 0], r0: 3, a: 0.55, rgb: GOLD, env: 'smooth', t1: 0.32, fout: 0.05 },
    { f: F.swirl, r0: 4, r1: 11, a: 0.5, rgb: ORANGE, ang: R.in(0, 6.28), spin: 0.25 * s, env: 'smooth', t0: 0.28, u0: 0, u1: 1.5 },
    flash(R, { t0: 0.34, r0: 6, a: 0.6, rgb: BLUE, rise: 0.12, tau: 0.45 })] };
});
kind('qpe', 'Quasi-periodic eruptions', 'X-ray bursts every few hours from a galaxy\'s core (something crashing through the disk each orbit)', 'black holes', (R) => (
  { ms: 24e3, parts: [host(R, { r: 18 }), { f: F.point, r0: 3, a: 0.25, rgb: GOLD }, { f: F.point, r0: 5, a: 0.7, rgb: TEAL, env: 'pulse', per: 3200, floor: 0 }] }));
kind('changing-look', 'Changing-look quasar', 'a quasar\'s bright core switched on (or off) within months', 'black holes', (R) => {
  const on = R.r() < 0.6;
  return { ms: 26e3, parts: [host(R, { r: 18, a: 0.28 }), { f: F.point, r0: 6, a: 0.75, rgb: BLUE, env: on ? 'rise' : 'fade', p: 0.15 }] };
});
kind('blazar', 'Blazar flare', 'a black hole\'s jet pointed straight at us suddenly flared', 'black holes', (R) => (
  { ms: 15e3, parts: [host(R, { ell: true, r: 12, a: 0.22 }), { f: F.point, r0: 6, a: 0.8, rgb: VIOLET, env: 'flicker', rise: 0.1, tau: 0.3, p: 0.25 }] }));
kind('jet', 'Relativistic jet', 'plasma beamed out at nearly light speed from a giant black hole (like M87\'s)', 'black holes', (R) => (
  { ms: 32e3, parts: [host(R, { ell: true, r: 13 }), { f: F.jets, r0: 26, a: 0.42, rgb: BLUE, ang: R.in(0, 6.28), p: 0.05, u0: 0, u1: 3 }, { f: F.point, r0: 3, a: 0.6, rgb: ICE }] }));
kind('binary-smbh', 'Binary supermassive black holes', 'two giant black holes orbiting after a merger; one flares as it hits the other\'s disk (like OJ 287)', 'black holes', (R) => (
  { ms: 26e3, parts: [host(R, { ell: true, r: 16 }), binary(R, { r0: 8, u0: 0, u1: 0.12, a: 0.45, rgb: GOLD, fout: 0.15 }),
    flash(R, { t0: 0.45, t1: 0.85, r0: 5, a: 0.6, rgb: ICE, rise: 0.15, tau: 0.35 })] }));
kind('runaway-bh', 'Runaway black hole', 'a black hole kicked out of its galaxy, leaving a trail of new stars', 'black holes', (R) => {
  const ang = R.in(0, 6.28), L = 42, c = Math.cos(ang), s = Math.sin(ang);
  return { ms: 32e3, parts: [host(R, { r: 12, a: 0.24 }), { f: F.arc, r0: L, a: 0.45, rgb: BLUE, ang, p: R.in(-0.15, 0.15), grow: true, u0: 0.05, u1: 1 },
    { f: F.point, x: 0, y: 0, to: [c * L, s * L], r0: 2.5, a: 0.5, rgb: ICE }] };
});
kind('gw-background', 'Gravitational-wave background', 'the hum of countless giant black hole pairs, light-years long (pulsar timing arrays, 2023)', 'black holes', (R) => (
  { ms: 40e3, parts: [ripple(R, { r0: 150, a: 0.05, p: 0.08, u0: 0.3, u1: 1, rgb: VIOLET })] }));

// ---- 5. galaxy events ----
kind('major-merger', 'Galaxy merger', 'two galaxies collide over hundreds of millions of years, flinging out tidal tails', 'galaxies', (R) => {
  const ang = R.in(0, 6.28), c = Math.cos(ang), s = Math.sin(ang), d = 18;
  return { ms: 60e3, parts: [host(R, { x: -c * d, y: -s * d, to: [-c * 5, -s * 5], r: 14 }), host(R, { x: c * d, y: s * d, to: [c * 5, s * 5], r: 13 }),
    { f: F.arc, x: -c * 5, y: -s * 5, r0: 26, a: 0.28, rgb: ICE, ang: ang + 2.6, p: 1.4, t0: 0.45 }, { f: F.arc, x: c * 5, y: s * 5, r0: 26, a: 0.28, rgb: ICE, ang: ang - 0.5, p: 1.4, t0: 0.45 },
    wash(R, { r0: 14, a: 0.12, rgb: ROSE, p: 3, t0: 0.55 })] };
});
kind('cannibalism', 'Galactic cannibalism', 'a big galaxy swallows a dwarf galaxy, pulling it into a stream of stars', 'galaxies', (R) => {
  const s = R.sg();
  return { ms: 50e3, parts: [host(R, { r: 20 }), host(R, { r: 5, a: 0.3, x: 28 * s, y: -10, to: [4 * s, -2] }),
    { f: F.arc, x: 4 * s, y: -2, r0: 30, a: 0.24, rgb: ICE, ang: s > 0 ? -0.3 : Math.PI + 0.3, p: 1.1 * s, t0: 0.4 }] };
});
kind('starburst', 'Starburst', 'a galaxy forming stars hundreds of times faster than normal (like M82)', 'galaxies', (R) => {
  const ang = R.in(0, 6.28);
  return { ms: 30e3, parts: [{ ...host(R, { r: 16 }), ang, p: 0.28 }, wash(R, { r0: 9, a: 0.22, rgb: ROSE, p: 3 }),
    dots(R, { r0: 11, a: 0.5, rgb: BLUE, p: 0.4 }), { f: F.jets, r0: 14, a: 0.14, rgb: ROSE, ang: ang + Math.PI / 2, p: 0.3, u0: 0, u1: 1 }] };
});
kind('ring-galaxy', 'Ring galaxy forming', 'a small galaxy punched through a larger one, sending out a ring of star birth (like the Cartwheel)', 'galaxies', (R) => {
  const s = R.sg();
  return { ms: 44e3, parts: [host(R, { r: 15, ell: true }), host(R, { r: 4, a: 0.3, x: -24 * s, y: -8, to: [26 * s, 8] }),
    { f: F.ring, r0: 3, r1: 17, a: 0.3, rgb: BLUE, p: 0.14, t0: 0.4, env: 'smooth', ang: R.in(0, 6.28) }] };
});
kind('tidal-tails', 'Tidal tails', 'two galaxies passing close fling long streams of stars out (like the Mice)', 'galaxies', (R) => {
  const ang = R.in(0, 6.28);
  return { ms: 40e3, parts: [host(R, { x: -7, y: -3, r: 10 }), host(R, { x: 7, y: 3, r: 9 }),
    { f: F.arc, x: -7, y: -3, r0: 30, a: 0.3, rgb: ICE, ang: ang, p: 0.8 }, { f: F.arc, x: 7, y: 3, r0: 26, a: 0.26, rgb: ICE, ang: ang + Math.PI, p: 0.8 }] };
});
kind('jellyfish', 'Jellyfish galaxy', 'a galaxy plowing through a cluster\'s hot gas loses it in trailing tentacles', 'galaxies', (R) => {
  const ang = R.in(0, 6.28), c = Math.cos(ang), s = Math.sin(ang);
  return { ms: 40e3, parts: [host(R, { r: 13, x: 6 * c, y: 6 * s, to: [-6 * c, -6 * s] }),
    ...[-0.25, 0, 0.25].map((o) => ({ f: F.arc, x: 6 * c, y: 6 * s, to: [-6 * c, -6 * s], r0: R.in(22, 30), a: 0.26, rgb: TEAL, ang: ang + o, p: R.in(-0.4, 0.4), t0: 0.1 }))] };
});
kind('harassment', 'Galaxy harassment', 'many fast fly-bys inside a cluster slowly wear a galaxy down', 'galaxies', (R) => (
  { ms: 40e3, parts: [host(R, { r: 13 }), ...[0, 1, 2].map((i) => { const a = R.in(0, 6.28), c = Math.cos(a), s = Math.sin(a);
    return host(R, { r: 4, a: 0.28, x: -32 * c, y: -32 * s, to: [32 * c + 6, 32 * s - 6], t0: i * 0.25, t1: i * 0.25 + 0.5 }); })] }));
kind('quenching', 'Galaxy quenching', 'a galaxy stopped forming stars for good: its blue arms fade to a red, smooth glow', 'galaxies', (R) => {
  const ang = R.in(0, 6.28);
  return { ms: 40e3, parts: [{ ...host(R, { r: 16, rgb: BLUE }), ang, env: 'fade' }, { ...host(R, { r: 15, ell: true, rgb: [1, 0.66, 0.5] }), ang, env: 'rise' }] };
});
kind('agn-outflow', 'Black hole outflow', 'winds from the central black hole push the galaxy\'s gas out at thousands of km/s', 'galaxies', (R) => (
  { ms: 35e3, parts: [host(R, { r: 16 }), { f: F.point, r0: 3, a: 0.6, rgb: GOLD }, shell(R, { r0: 4, r1: 26, a: 0.16, p: 0.35, rgb: GOLD, env: 'smooth' })] }));
kind('jet-stars', 'Jet-triggered star formation', 'a black hole\'s jet squeezes gas and sets off star birth (Minkowski\'s Object)', 'galaxies', (R) => {
  const ang = R.in(0, 6.28);
  return { ms: 34e3, parts: [host(R, { ell: true, r: 10 }), { f: F.jets, r0: 24, a: 0.32, rgb: BLUE, ang, p: 0.05, u0: 0, u1: 2 },
    dots(R, { x: Math.cos(ang) * 22, y: Math.sin(ang) * 22, r0: 7, a: 0.55, rgb: BLUE, p: 0.5, t0: 0.35 })] };
});
kind('hypervelocity', 'Hypervelocity star', 'a star flung out of its galaxy by a black hole', 'galaxies', (R) => {
  const ang = R.in(0, 6.28), L = 34;
  return { ms: 26e3, parts: [host(R, { r: 12, a: 0.22 }), { f: F.arc, r0: L, a: 0.2, rgb: ICE, ang, p: 0, grow: true, u0: 0.05, u1: 1 },
    { f: F.point, to: [Math.cos(ang) * L, Math.sin(ang) * L], r0: 2.5, a: 0.55, rgb: WHITE }] };
});

// ---- 6. galaxy cluster events ----
kind('cluster-collision', 'Cluster collision', 'two galaxy clusters smashed through each other; the gas lagged, the dark matter did not (the Bullet Cluster)', 'clusters', (R) => {
  const ang = R.in(0, 6.28), c = Math.cos(ang), s = Math.sin(ang);
  return { ms: 50e3, parts: [dots(R, { x: -30 * c, y: -30 * s, to: [14 * c, 14 * s], r0: 14, p: 0.4, rgb: DUST }), dots(R, { x: 30 * c, y: 30 * s, to: [-14 * c, -14 * s], r0: 12, p: 0.4, rgb: DUST }),
    wash(R, { r0: 14, r1: 18, a: 0.14, rgb: ROSE, p: 2, t0: 0.4 }), wash(R, { x: 14 * c, y: 14 * s, r0: 14, a: 0.07, rgb: BLUE, p: 1.2, t0: 0.55 }), wash(R, { x: -14 * c, y: -14 * s, r0: 14, a: 0.07, rgb: BLUE, p: 1.2, t0: 0.55 })] };
});
kind('radio-relic', 'Radio relic', 'shock fronts millions of light-years wide from merging clusters', 'clusters', (R) => {
  const ang = R.in(0, 6.28), c = Math.cos(ang), s = Math.sin(ang);
  return { ms: 40e3, parts: [dots(R, { r0: 18, p: 0.4, rgb: DUST }), { f: F.arc, x: 26 * c - 14 * s, y: 26 * s + 14 * c, r0: 28, a: 0.3, rgb: VIOLET, ang: ang - Math.PI / 2, p: -1.6 },
    { f: F.arc, x: -26 * c + 14 * s, y: -26 * s - 14 * c, r0: 24, a: 0.24, rgb: VIOLET, ang: ang + Math.PI / 2, p: -1.6 }] };
});
kind('cluster-cavities', 'Cluster cavities', 'black hole jets blow bubbles in a cluster\'s hot gas (Perseus "sings" a B-flat 57 octaves down)', 'clusters', (R) => {
  const ang = R.in(0, 6.28), c = Math.cos(ang) * 11, s = Math.sin(ang) * 11;
  return { ms: 40e3, parts: [wash(R, { r0: 26, a: 0.11, rgb: ICE, p: 1.6 }), { f: F.dark, x: c, y: s, r0: 6, a: 0.12 }, { f: F.dark, x: -c, y: -s, r0: 6, a: 0.12 },
    { f: F.ring, x: c, y: s, r0: 6, a: 0.16, rgb: ICE, p: 0.2 }, { f: F.ring, x: -c, y: -s, r0: 6, a: 0.16, rgb: ICE, p: 0.2 },
    ripple(R, { r0: 30, a: 0.05, p: 0.18, u0: 0.3, u1: 1, t0: 0.2 }), host(R, { ell: true, r: 6, a: 0.35 })] };
});
kind('bcg-growth', 'Brightest cluster galaxy growing', 'a giant elliptical slowly swallowing its neighbours at a cluster\'s heart', 'clusters', (R) => (
  { ms: 40e3, parts: [dots(R, { r0: 30, r1: 18, p: 0.45, rgb: DUST }), host(R, { ell: true, r: 9, a: 0.4 }), host(R, { ell: true, r: 7, r1: 11, a: 0.2, rgb: GOLD })] }));
kind('protocluster', 'Protocluster', 'a galaxy cluster still assembling in the early universe (like the Spiderweb)', 'clusters', (R) => (
  { ms: 40e3, parts: [dots(R, { r0: 24, p: 0.5, rgb: [1, 0.66, 0.5], a: 0.4 }), wash(R, { r0: 22, a: 0.06, rgb: ORANGE, p: 2 })] }));

// ---- 7. exotic signals ----
kind('frb', 'Fast radio burst', 'a millisecond radio flash from billions of light-years away (some repeat)', 'exotic', (R) => {
  const rep = R.r() < 0.4;
  return { ms: rep ? 12e3 : 6e3, quick: true, parts: rep ? [0.05, 0.4, 0.7].map((t) => blink({ t0: t, t1: t + 0.04, r0: 4, a: 0.8, rgb: ICE, p: 0.2 }))
    : [blink({ t0: 0.1, t1: 0.16, r0: 4, a: 0.8, rgb: ICE, p: 0.2 })] };
});
kind('orc', 'Odd radio circle', 'a huge ring of radio light around a galaxy; nobody knows what makes it', 'exotic', (R) => (
  { ms: 30e3, parts: [host(R, { ell: true, r: 5, a: 0.35 }), { f: F.ring, r0: 18, a: 0.22, rgb: TEAL, p: 0.1, env: 'smooth', ang: R.in(0, 6.28) }] }));
kind('uhecr', 'Ultra-high-energy cosmic ray', 'a single particle carrying the energy of a fast tennis ball (like the Oh-My-God particle)', 'exotic', (R) => {
  const ang = R.in(0, 6.28), L = 30;
  return { ms: 5e3, quick: true, parts: [{ f: F.arc, r0: L, a: 0.5, rgb: [0.86, 0.8, 1], ang, p: 0, grow: true, env: 'fade', u0: 0.02, u1: 1 },
    { f: F.point, to: [Math.cos(ang) * L, Math.sin(ang) * L], r0: 2.5, a: 0.6, rgb: WHITE, env: 'fade' }] };
});
kind('neutrino', 'High-energy neutrino', 'a ghost particle from a far black hole, caught by its faint blue glow (like IceCube\'s)', 'exotic', (R) => (
  { ms: 6e3, quick: true, parts: [blink({ t0: 0.05, t1: 0.25, r0: 3, a: 0.6, rgb: BLUE, p: 0 }), shell(R, { t0: 0.05, t1: 0.6, r0: 2, r1: 9, a: 0.3, rgb: BLUE, p: 0.12 })] }));
kind('planet-transit', 'Planet in another galaxy', 'an X-ray star dims as a planet crosses it (M51-ULS-1b, the first candidate)', 'exotic', (R) => {
  const [x, y] = inHost(R, 9);
  return { ms: 22e3, parts: [host(R, { r: 20 }), { f: F.point, x, y, r0: 4, a: 0.6, rgb: TEAL, env: 'dip' }] };
});

// ---- 8. gravitational lensing ----
kind('lensed-supernova', 'Multiply imaged supernova', 'a cluster\'s gravity split one supernova into four images that flash at different times (Refsdal)', 'lensing', (R) => {
  const ang = R.in(0, 6.28), Rr = 14;
  return { ms: 32e3, parts: [host(R, { ell: true, r: 9, a: 0.35 }), { f: F.arcs, r0: Rr, a: 0.2, rgb: BLUE, p: 4, ang },
    ...[0, 1, 2, 3].map((i) => flash(R, { x: Math.cos(ang + (i * Math.PI) / 2) * Rr, y: Math.sin(ang + (i * Math.PI) / 2) * Rr, r0: 4, a: 0.7, t0: 0.08 + i * 0.12, t1: 0.5 + i * 0.12, tau: 0.3 }))] };
});
kind('h0pe', 'Lensed supernova (SN H0pe)', 'one supernova seen three times, months apart, to measure how fast the universe expands', 'lensing', (R) => {
  const ang = R.in(0, 6.28), Rr = 13;
  return { ms: 30e3, parts: [host(R, { ell: true, r: 8, a: 0.35 }), { f: F.arcs, r0: Rr, a: 0.22, rgb: BLUE, p: 3, ang },
    ...[0, 1, 2].map((i) => flash(R, { x: Math.cos(ang + (i * 2 * Math.PI) / 3) * Rr, y: Math.sin(ang + (i * 2 * Math.PI) / 3) * Rr, r0: 4, a: 0.65, t0: 0.08 + i * 0.2, t1: 0.45 + i * 0.2, tau: 0.3 }))] };
});
kind('caustic-star', 'Single star magnified (Earendel)', 'one star from 12.9 billion years ago, magnified thousands of times on a lensed arc', 'lensing', (R) => {
  const ang = R.in(0, 6.28);
  return { ms: 26e3, parts: [host(R, { ell: true, r: 8, a: 0.3 }), { f: F.arcs, r0: 16, a: 0.24, rgb: ICE, p: 2, ang },
    flash(R, { x: Math.cos(ang) * 16, y: Math.sin(ang) * 16, r0: 4, a: 0.6, rise: 0.45, tau: 0.25 })] };
});
kind('einstein-ring', 'Einstein ring', 'a galaxy behind another smeared into a full ring by its gravity', 'lensing', (R) => (
  { ms: 30e3, parts: [host(R, { ell: true, r: 7, a: 0.4 }), { f: F.arcs, r0: 13, a: 0.28, rgb: BLUE, p: 1, ang: R.in(0, 6.28) }] }));
kind('einstein-cross', 'Einstein cross', 'one far quasar split into four points around a galaxy', 'lensing', (R) => (
  { ms: 30e3, parts: [host(R, { ell: true, r: 7, a: 0.4 }), { f: F.arcs, r0: 11, a: 0.4, rgb: ICE, p: 4, ang: R.in(0, 6.28) }] }));

// ---- 9. cosmic history (stylised: these happened everywhere, long ago) ----
kind('big-bang', 'The Big Bang', 'everything from a hot, dense start 13.8 billion years ago (a reenactment)', 'cosmic', (R) => (
  { ms: 26e3, parts: [flash(R, { r0: 7, a: 0.85, rise: 0.04, tau: 0.12, p: 0.3 }), wash(R, { r0: 3, r1: 60, a: 0.1, rgb: GOLD, p: 3, env: 'fade', t0: 0.03 }),
    shell(R, { r0: 3, r1: 70, a: 0.14, rgb: ORANGE, p: 0.1, t0: 0.03 })] }));
kind('inflation', 'Cosmic inflation', 'space swelled exponentially in the first 10^-32 s (theory; a reenactment)', 'cosmic', (R) => (
  { ms: 16e3, parts: [dots(R, { r0: 4, r1: 60, a: 0.35, p: 0.3, env: 'fade', rgb: ICE })] }));
kind('nucleosynthesis', 'Big Bang nucleosynthesis', 'hydrogen, helium and a little lithium formed in the first three minutes', 'cosmic', (R) => (
  { ms: 22e3, parts: [wash(R, { r0: 30, a: 0.1, rgb: ORANGE, p: 4, env: 'fade' }), dots(R, { r0: 28, a: 0.3, p: 0.25, rgb: GOLD, env: 'fade' })] }));
kind('recombination', 'Recombination (the CMB)', 'the first light the universe let go, 380,000 years in: the cosmic microwave background', 'cosmic', (R) => (
  { ms: 32e3, parts: [wash(R, { r0: 90, a: 0.06, rgb: ORANGE, p: 6 })] }));
kind('dark-ages', 'Cosmic dark ages', 'the long dark before the first stars', 'cosmic', (R) => (
  { ms: 26e3, parts: [{ f: F.dark, r0: 60, a: 0.22, env: 'smooth' }] }));
kind('cosmic-dawn', 'Cosmic dawn', 'the first stars switch on (Population III, not yet confirmed)', 'cosmic', (R) => (
  { ms: 32e3, parts: [{ f: F.dark, r0: 40, a: 0.16, env: 'smooth' }, dots(R, { r0: 30, a: 0.55, p: 0.18, rgb: BLUE, env: 'rise', t0: 0.15 })] }));
kind('reionization', 'Reionization', 'light from the first galaxies burns bubbles through the cosmic fog', 'cosmic', (R) => (
  { ms: 36e3, parts: [wash(R, { r0: 50, a: 0.07, rgb: DUST, p: 3, env: 'fade' }),
    ...[0, 1, 2, 3].map((i) => wash(R, { x: R.in(-28, 28), y: R.in(-20, 20), r0: 2, r1: R.in(12, 20), a: 0.1, rgb: ICE, p: 2, t0: i * 0.15 }))] }));
kind('early-smbh', 'Early black hole ("little red dot")', 'a surprisingly big black hole less than a billion years after the Big Bang (JWST)', 'cosmic', (R) => (
  { ms: 26e3, parts: [host(R, { r: 6, a: 0.16 }), { f: F.point, r0: 3.5, a: 0.6, rgb: RED }] }));
kind('cosmic-web', 'Cosmic web', 'dark-matter filaments feed gas into galaxies; voids empty out between them', 'cosmic', (R) => (
  { ms: 40e3, parts: [{ f: F.web, r0: 80, a: 0.11, rgb: VIOLET, p: 3, env: 'smooth' }] }));
kind('dark-energy', 'Dark energy takes over', 'the universe\'s expansion started speeding up 5 billion years ago', 'cosmic', (R) => (
  { ms: 40e3, parts: [dots(R, { r0: 18, r1: 44, a: 0.4, p: 0.35, rgb: DUST })] }));

// ---- 10. the far future ----
kind('milkomeda', 'Milky Way + Andromeda', 'the two galaxies collide in about 4.5 billion years and become "Milkomeda" (a preview)', 'future', (R) => {
  const ang = R.in(0, 6.28), c = Math.cos(ang), s = Math.sin(ang), d = 26;
  return { ms: 70e3, parts: [host(R, { x: -c * d, y: -s * d, to: [0, 0], r: 18, t1: 0.75 }), host(R, { x: c * d, y: s * d, to: [0, 0], r: 22, t1: 0.75 }),
    { f: F.arc, r0: 34, a: 0.24, rgb: ICE, ang: ang + 2.2, p: 1.2, t0: 0.4 }, { f: F.arc, r0: 34, a: 0.24, rgb: ICE, ang: ang - 0.9, p: 1.2, t0: 0.4 },
    host(R, { ell: true, r: 20, a: 0.34, t0: 0.6, rgb: GOLD })] };
});
kind('local-group-alone', 'The Local Group alone', 'every other galaxy recedes past the cosmic horizon, 100 billion years on', 'future', (R) => (
  { ms: 40e3, parts: [dots(R, { r0: 26, r1: 60, a: 0.38, p: 0.3, rgb: DUST, env: 'fade' }), host(R, { r: 10, a: 0.36 })] }));
kind('last-stars', 'The last stars form', 'star formation ends, about 100 trillion years from now', 'future', (R) => (
  { ms: 36e3, parts: [dots(R, { r0: 24, a: 0.45, p: 0.4, rgb: GOLD, env: 'fade' }), dots(R, { r0: 24, a: 0.35, p: 0.2, rgb: RED, env: 'rise', t1: 0.9 })] }));
kind('degenerate-era', 'Degenerate era', 'only white dwarfs, neutron stars and black holes left, cooling in the dark', 'future', (R) => (
  { ms: 30e3, parts: [dots(R, { r0: 30, a: 0.35, p: 0.15, rgb: ICE, env: 'fade' })] }));
kind('evaporation', 'Black hole evaporation', 'a black hole leaks Hawking radiation for 10^67+ years, then pops', 'future', (R) => (
  { ms: 26e3, parts: [{ f: F.dark, r0: 7, r1: 1, a: 0.4, env: 'smooth', t1: 0.88, fout: 0.05 }, { f: F.ring, r0: 7, r1: 1, a: 0.12, rgb: VIOLET, p: 0.25, t1: 0.88, fout: 0.05 },
    blink({ t0: 0.86, t1: 0.94, r0: 4, a: 0.7, p: 0.3 })] }));
kind('heat-death', 'Heat death', 'the most likely end: everything spread thin and cold, nothing left to happen', 'future', (R) => (
  { ms: 30e3, parts: [dots(R, { r0: 26, r1: 40, a: 0.35, p: 0.3, rgb: DUST, env: 'fade' })] }));
kind('big-rip', 'Big Rip', 'one possible end: dark energy tears apart galaxies, stars, then atoms', 'future', (R) => (
  { ms: 26e3, parts: [dots(R, { r0: 14, r1: 70, a: 0.4, p: 0.35, rgb: ROSE, env: 'fade' }), shell(R, { r0: 4, r1: 60, a: 0.12, rgb: ROSE, p: 0.06 })] }));
kind('big-crunch', 'Big Crunch', 'one possible end: everything falls back together', 'future', (R) => (
  { ms: 26e3, parts: [dots(R, { r0: 50, r1: 4, a: 0.38, p: 0.3, rgb: GOLD, t1: 0.86, fout: 0.05 }), blink({ t0: 0.84, t1: 0.95, r0: 6, a: 0.8 })] }));
kind('vacuum-decay', 'Vacuum decay', 'one possible end: a bubble of a truer vacuum grows at light speed', 'future', (R) => (
  { ms: 24e3, parts: [{ f: F.dark, r0: 2, r1: 40, a: 0.22, env: 'fade' }, { f: F.ring, r0: 2, r1: 42, a: 0.3, rgb: ICE, p: 0.06, env: 'fade', ang: R.in(0, 6.28) }] }));

export const FAR_KINDS = new Map(K);
