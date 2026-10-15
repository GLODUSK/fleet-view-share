// Fleet View web: the Map view.
//
// A graph of conversations, their agents, repos, PRs and the files they touch, drawn on a canvas.
// The layout is a small hand-written spring and repulsion simulation that keeps its positions between
// polls, so nodes never jump: new nodes start next to what they link to and the rest stays put.
//
// Rule (Henry): nothing pulses, blinks, flashes or gets brighter when something happens. Life comes from
// MOTION at constant brightness only: tool calls travel as comets along an edge, a working conversation's
// ring of dots turns slowly, running agents orbit, nodes drift a few pixels, and recent-work dashes flow.
// The aura behind a conversation grows with its tool calls but its alpha is fixed. Fades are driven by age
// only (recent-work paths dim steadily over ten minutes). sin/cos are used for positions, angles and scale,
// never for alpha. A comet arriving at a repo or a conversation nudges it: a short scale bump (at most one per
// 250 ms) and, for a repo, a kick of its ring's rotation; nothing gets brighter. prefers-reduced-motion turns
// off drift, orbit, rotation, flow and these nudges (comets still travel).
//
// Merge launch (Henry merges dozens of PRs a day; each gets a small payoff, all motion): when a conversation's PR
// merges (a new 'merged' alert in state.alerts, see ingestMerges), the conversation sends one big comet with a long
// tail to its repo's hub along their curve. As it lands, the hub's ring makes one extra full turn (WHIRL_MS, easing
// out) with the usual bump, and a ring of sparks in the repo's colour flies out, curling a little and slowing down,
// each spark shrinking to nothing at a fixed alpha (I.bursts). A conversation that isn't on the map spins its hub
// without a comet. prefers-reduced-motion keeps the comet only; replay launches nothing.
//
// Transitions (Henry, 2026-10-07: changes of state must feel organic, not snap): a conversation's look morphs
// into its next one over MORPH_MS (the new look settles in from 90% size over the old one); its size, aura,
// memory gauge, link and turning ring all glide (exponential easing, see glide). Going idle, the ring of dots
// slows to a stop while its dots shrink into the orb; starting work, they grow out and pick up speed. A new
// conversation or repo grows in with a slight overshoot (BIRTH_MS); one that leaves shrinks as it fades.
// A handoff is no new conversation (Henry, 2026-10-12): the pickup's node takes over the old one's spot, look and
// pick (state.handoffPairs, carryNode), so nothing is born next to the hub and nothing leaves; when it turns from
// handing off to live, one violet ring spreads from it and fades (RELAY_MS).
// prefers-reduced-motion snaps all of these to their end.
//
// Look: conversations and agents are lit orbs; a repo is a hub (a faceted hexagon in its colour, with the repo's
// initial, inside a turning ring of arcs with ticks) in its own nebula: a few soft overlapping clouds in the repo's
// colour (one a lighter tint), shaped by the repo's id, that slowly change shape at fixed brightness, so each repo
// reads as a coloured region with its conversations inside. Its name sits on a pill in its colour right next to it.
// On a big window (past about 1600x900) orbs, rings, labels and pills all grow with it, so a 4K map isn't tiny dots.
// A hub shows presence by size and motion: each live conversation is a small satellite
// in its colour orbiting the hub, a soft halo widens and the ring's arcs lengthen while it has live
// conversations, and the ring turns faster (plus an inner counter-turning dash ring grows) while they work.
// A dormant hub (no live conversation) is smaller, its arcs short, turning slowly; PRs are small rings with a pull-request glyph; edges are gentle curves (always
// bent to the same side for a pair, the bend swaying slowly like a rope) with a colour gradient, and names sit on small frosted pills.
// Behind it all, three layers of faint tiny stars (STAR_LAYERS) at fixed brightness: all of them slide with the
// pan as the map does (no parallax: panning shows more sky), hold still on zoom and when a panel opens beside the
// map, and creep slowly by themselves (not when still).
// Some gather in loose clusters; most are white, a few blue-white to amber (STAR_TINT), a few are tiny sparkles.
// A few of the brightest in the two front layers (mostly the nearest) twinkle faintly (TWINKLE_*): a slow, calm
// swell of their brightness, each at its own pace; none while the map rests, is hidden or under reduced motion, and
// none when the canvas draws the sky (no WebGL2, ?sky2d=1).
// Now and then (every 20-60 s, METEOR_*) a shooting star: a faint thin streak, tinted like the stars, falls across
// the sky for half a second, fixed to the screen; none while the map rests, is hidden or under reduced motion.
// A merge landing on a hub (landed) sets off a meteor shower (SHOWER_*): 4-6 such streaks over about 2 s, all
// flying away from one point high in the sky above that hub, at most one shower per SHOWER_GAP (merges during one
// don't add to it); the same rules (none at rest, hidden or under reduced motion, none for merges that are history).
// A small soft moon (MOON_*) shows tonight's real phase (lit from the right while waxing, the left while waning, a
// faint earthshine on its dark side, a halo as bright as it is full) and crosses the top of the screen with the local
// clock, east (left) to west: it lags the sun by its phase (full rises at dusk, last quarter is high at dawn), sets
// below the horizon and fades out by day. It slides with the pan as the stars do (a long pan takes it off one side and
// back in from the other); worked out once a minute, painted once per phase.
// Satellites (SAT_*; Henry asked for them): one small steady point, a little warm, for each background agent or
// workflow agent running on the map (at most SAT_N), drifting slowly across the upper sky on a straight, slightly
// tilted path (a minute or two to cross the window) with a faint red or white beacon blink every couple of seconds, so
// it reads as a satellite, not a star or a meteor. A new one fades in somewhere along its path; when its agent ends it
// fades out where it is; one that leaves the window comes back on a new path while its agent runs. Fixed to the window
// like the moon, on the map's clock (held at rest), still and unblinking under reduced motion, dimmer by day.
// A deploy going live (ingestDeploys; Henry asked for it, next to the shower for a merge) sends up a rocket (ROCKET_*): a
// small warm white-gold head climbing from the window's bottom edge under its repo's hub, leaning a little and bending
// further as it goes, slowing all the way to about half the window's height in about 3 s, its gold trail turning orange
// and faint down it and wavering; at the top it flares and burns out in a tiny puff of sparks, and the trail fades.
// Up, warm and slowing, so never taken for a meteor. Once per deploy (not for ones already live when the page opens);
// fixed to the window like the moon; none at rest, hidden or under reduced motion.
// Space events (EVENT_*): every minute or two (EVENT_GAP, a pick) the director starts one more ambient sight from the
// registry (EVENTS, by weight, never a kind already up, never the kind it started last), beside the ones still running, up to
// EVENT_MAX at once (Henry, 2026-10-14: "make sure events can happen at the same time"), so a capital ship can cross while
// a battle burns and a planet turns; far rarer than a shooting star and slow; like the meteors they are tied to no app
// state, move with the sky's camera at the depth that suits them (eventCam), and none starts while the map rests, is
// hidden or under reduced motion (the running ones end, as the meteors do). It is one sky: the far ones (the ship, the
// battle, the planet) are drawn where the gravity lens bends the light, so a black hole passing in front warps them, and a
// black hole that comes near the capital ship or a planet pulls it in (see the devouring below); a kind that can meet one
// already up is picked EVENT_PAIR times as often, and its path is often aimed to cross it (DEVOUR_AIM_P).
// The nebula drift (event 'nebula', NEBULA_*): a huge, dim cloud of coloured dust takes a minute or two to drift across the
// far sky, the stars showing through it (the shader lays it under them). Warped, layered noise gives it wispy
// filaments and soft dark dust lanes, not a blob, in a body tint, a lighter wisp tint and a faint contrasting edge, a
// palette picked from a few tasteful sets (NEBULA_PALETTES) each time. Its brightness is constant: it fades only by
// its place (its edge is soft, and it starts and ends off the window), and follows the far star layer's pan and zoom.
// The canvas fallback (no WebGL2) shows none.
// The asteroid field (event 'asteroids', ASTEROID_*): a loose stream of tumbling dark rocks crosses the sky at the far
// star layer's depth (tiny and slow; Henry 2026-10-14: the mid, near and close ones were too big, so they are gone),
// each with its own lumpy silhouette (a noise-bent ellipse, never a circle), a slow spin of its own, a mottled, faintly
// bumpy surface, a thin warm rim light on the side facing the light (one direction for the whole field) and a cool
// hint of fill on the other, with a few motes of dust about the bigger ones. Now and then (ASTEROID_CLOSE_P) one drifts
// close: huge, dark, in soft focus (its edge blurred, its rim faint), crossing in front of everything, the moon too. Its
// brightness is constant: rocks start off the window (or fade in by their age if they begin inside it) and leave it,
// and nothing pulses. At most ASTEROID_N at once (the shader has a slot for each); the canvas fallback shows none.
// The gravity lens (event 'lens', LENS_*): a black hole you can hardly see drifts across the sky at the middle star layer's
// depth, and the sky bends round it: everything under the satellites (the stars, the nebula, the deep sky) is looked up
// where a point lens would send the light (LENS_R squared over the distance), so the stars near it swing into a thin
// Einstein ring and smeared arcs and the rest of the sky is only a little out of true, nothing at all past LENS_REACH
// radii. At its middle sits a small dark core in a faint shade, and a thin, very dim, warm accretion ring a little brighter
// on one side. A couple of far galaxies (LENS_SRC), too faint to see by themselves, slide behind it as it passes and are
// pulled into arcs that wander round the ring, closing to a full one as one lines up. Brightness is constant: it comes in
// off the window and leaves off it, and a galaxy's arcs only fade by where it lies. The canvas fallback shows none.
// The distant capital ship (event 'ship', SHIP_*): a huge, dim silhouette takes three to five minutes to cross the sky at
// the far star layer's depth, level but for a slight tilt, either way, seen mostly as a dark shape against the
// stars (it hides them). Its hull is a signed distance field in the shader (SHIP_HULL, SHIP_BOXES, SHIP_NOTCH): a long
// layered wedge, a stepped upper deck, a keel with a hangar mouth, a bridge tower and a forward block with a mast, small
// turrets, an engine block with two nozzles, and a few notches cut into its edges, so it is not one triangle. A thin cool rim
// light runs along every edge that faces the light (one star, high and a little behind: warmer towards the bow), with a
// soft sheen fading into the hull below it and a trace of bounce on the underside. It is a long way off, seen through haze:
// the hull takes on the sky's cool haze (more of it low on the hull, and on the escort, further still), its edges are a
// little soft, a faint veil of haze glows just outside them and its lights are muted. A handful of tiny, warm windows (a hash
// picks which cells of a few rows are lit, SHIP_WINDOW_P) and, at the stern, two dim engine glows with a short faint plume
// are the only lights. Sometimes (SHIP_ESCORT_P) a small escort, the same ship at a fraction of the size, follows a little behind and
// to one side. Brightness is constant, no light blinks or pulses. It comes out of hyperspace (Henry, 2026-10-14: "like Elite
// Dangerous"): partway into the window a jump point opens, a churning blue cloud round a thin white slit across its path, and
// with a flash the ship breaks out of it bow first, smeared along its heading and glowing blue, fast, then slows to its cruise
// within a second or so (the escort comes out of the same rift just after it); what is still behind the rift is not drawn, and
// the rift folds shut once both are out. It leaves off the far side of the window as before. The canvas fallback shows none.
// The warp drift (event 'warp', WARP_*): now and then, for a second or two, the stars stretch into long streaks along one
// direction and settle back, like a hyperspace jump seen from far away. Motion only: no flash, nothing brightens, a star
// keeps its light and just lengthens (the shader looks each star layer up through a squeeze of the sky along that direction
// about a point, so a star is drawn WARP_STRETCH times longer, its soft round ends tapering into the streak), eased in and
// out (smoothstep, WARP_IN, WARP_OUT) with a slight radial feel from that point (WARP_RADIAL), the streaks fanning a little.
// Every star layer stretches, the near ones more (WARP_LAYER), the deep sky only a little (WARP_DEEP). It sits under the lens
// and the twinkle and the tile wrap as they are (it only moves the lookup point), and its point follows the middle star
// layer's pan and zoom. The canvas fallback shows none.
// The planet (event 'planet', PLANET_*; Henry, 2026-10-14: "planets with a lot of atmosphere like we did with the ships so they
// seem far"): a big world takes two or three minutes to drift across the far sky, coming in off the window and leaving
// off it, lit by one far star from a side (now and then from behind it: a thin crescent inside a whole ring of lit air).
// One of a few kinds (PLANET_KINDS): a banded gas giant whose belts turn at their own speeds round a churning storm oval,
// an ocean world of clouds over continents with a glint on its seas and city lights on its night side, an ice giant, a
// world drowned in orange haze, a rust desert with white poles. Every one turns all the while (its clouds faster than its
// ground), its day side fades through a reddened band of dusk into the night, its limb darkens on a gas giant, and its air
// shows: a soft rim of the air's colour on the disc and a glow round it that thins outwards, brightest towards its star,
// and lit right round when the star is behind it. Some have rings (banded, with gaps, the planet's shadow across them, the
// near side over the planet and the far side behind it) and some a small moon going round them, in front and then behind.
// It is far: its colours take a share of the sky's haze (PLANET_HAZE), and it hides the stars behind it (its night side too).
// The space battle (event 'battle', BATTLE_*; Henry, 2026-10-14: "add ship battles in the background or them interacting with
// each other...make it interesting"): two small fleets, far off and hazed like the capital ship (the same hull, smaller), one
// with a cool blue light and one with a warm red, drop out of hyperspace one ship after another (the rift and flash of the
// capital ship) and pass each other on opposite courses, slowly, broadside to broadside. Their turrets fire volleys of
// short bolts in their side's colour that strike the other's hull in small flashes or splash on its shield in a faint
// ripple (the shields fail as the fight goes on, and then the hits start fires); torpedoes curve across with long faint
// trails and burst, or are shot down halfway by point defence; fighters launch from the hangars and dogfight between the
// lines, each chased by one of the other side's on its own looping path, firing tracers, and now and then one bursts.
// Then one ship loses: explosions run along its hull, fires take, it breaks in two with a big flash, a shock ring and a
// spray of debris, and its halves tumble apart, burning, until each goes up in a last burst of debris. The fighters
// fly home and the survivors jump away into rifts of their own. Nothing in it is ever still. The canvas fallback shows none.
// The devouring (DEVOUR_*): while the gravity lens is up, the capital ship or a planet that comes within DEVOUR_REACH of it is
// caught (once there is time left for it): it is drawn off its path into a spiral round the hole, faster and faster,
// stretched along the way it falls (spaghettified), heating red then white, its air (or for the ship, its burning hull)
// torn off in a glowing stream that winds in ahead of it to the ring, until it shrinks into the ring and is gone; the ring
// then flares and the hole fires two thin jets, knots racing out along them, that fade over a few seconds. The black hole
// keeps on its way. Logged as 'devour' (switch it off to keep them apart).
// Far events (FAR_*; Henry 2026-10-14: everything in his list of space events beyond our galaxy, "more like BG happening",
// logged so he can ask what one was): a second, quieter director with its own clock (FAR_GAP, about once a minute, one
// at a time, beside the space events above) shows every kind in web/sky-far.js's catalog once, in a shuffled order,
// before any repeats: supernovae, kilonovae, gamma-ray bursts, black hole mergers, tidal disruptions, jets, galaxy
// mergers, cluster collisions, fast radio bursts, lensed images, the cosmic history, the far future (74 kinds). Each
// is a few small parts the shader draws from one function (FAR_GLSL farPart: a point with its glare and spikes, a
// remnant's filaments, jets, a galaxy with dust lanes and star clumps, a stream of stars, an inspiralling pair, a debris
// swirl, a cloud of gas, the cosmic web, lensed arcs, ripples, a swarm of dots, a dark cloud, a flash's light echo), each
// drawn after the real thing in a deep photo; the ten most striking (supernova, kilonova, galaxy collision, tidal disruption, gamma-ray burst,
// quasar, magnetar flare, black hole merger, ring galaxy, jellyfish galaxy) each have a signature shape of their own that
// tells their whole story over their life, from noise seeded per part so no two look alike, and each with its own light over time (a
// flash, pulses, a fade...). Nothing in one stands still (Henry, 2026-10-14: "make sure the events arent static ... some
// of them just fade out...thats boring"): every part moves all its life, by the event's own clock (gas churns and turns,
// filaments writhe, discs and swarms go round, faster inside, knots and stars stream, light runs along the web into its
// knots, points scintillate), and comes in and goes out through its shape, never by a plain fade: a cloud gathers in and
// is torn into wisps as it spreads out, a point lights its core, its halo and its spikes in turn and cools as it goes,
// jets run out and go dark from their base, a spiral's arms wind up out of a glow and it recedes, smaller and redder,
// lensed arcs grow out of their images and shrink back into them, a swarm's points switch on and cool and die one by
// one, and a flash's light spreads on through the dust round it as a broken ring (its echo). All of it is far and faint: a
// flash is a few px with a soft halo, a galaxy a smudge, and only the cosmic washes are big, at a few percent alpha. It
// goes where the orbs and hubs are not (farPlace: FAR_CLEAR px clear of every one on screen, the best of FAR_TRIES
// places), under the stars, at the far star layer's depth. Every start (and every space event's) is logged on the
// server (POST /sky-events: the time, its label, one line on what it is, where on the window), and the kinds Henry
// switched off (GET /sky-events: off) never show. None at rest, hidden or under reduced motion; the canvas shows none.
// The faint back layer is a tile repeated; the two front ones, sparse and bright enough that a repeat would show,
// never repeat when the graphics card draws them: it places their stars itself, at most one per cell of a grid,
// each cell's star (or none) from a hash of the cell (STAR_FIELD_GLSL). The canvas repeats a tile for all three.
// Deeper still (DEEP_*), following even less of the pan: a faint Milky Way band (a soft glow cut by dark dust lanes,
// with fine star dust where it is dense), a few big dim gas clouds and three tiny far galaxies (DEEP_GALAXIES: a
// tilted two-armed spiral, an edge-on one and a fuzzy elliptical), painted once, at fixed brightness.
// Under the stars a faint sky tint follows the local clock (SKY_KEYS: indigo night, rose dawn, clear day, amber dusk);
// it changes by the minute, never because something happened. Over the sky (never the nodes) a soft vignette darkens
// the edges, and a still dither, fixed to the pixel, keeps the faint gradients from banding. The graphics card draws
// the sky (tint, deep sky, stars, vignette) and the repo nebulae over it in one pass on a WebGL2 canvas off the page
// (drawSkyGL), in float before that one dither, so the nebulae's soft edges show no steps; it draws only when
// something in it changed, and the map's canvas lays that picture down first each frame. Without WebGL2 the map's
// canvas draws the tint and stars itself (drawSky, drawStars), without the deep sky and vignette, and the nebulae
// (drawTerritories), as it does too without half-float textures.
//
// Repo spots (Henry: repos must never jump across the map): every repo keeps the spot it first got. Only the
// first layout packs the repos in rows to fit the window; a repo that appears later takes the nearest free spot
// around the others, and one that leaves keeps its spot for when it comes back, so nothing else moves. The
// spacing rule may still nudge a group a little (and its spot moves with it). Dragging a repo's hub moves its
// whole group and pins it there: a pinned repo never moves by itself, and others make way for it. Spots and
// pins are saved (settings.mapSpots), so they survive reloads, and they are shared live: a spot another screen
// changes (Fleet View open on another computer too) is applied here from the next /state (syncSpots), so a repo
// dragged there moves here within a second. Zoom, pan and selection stay this screen's own. A repo added from the map's empty-space menu
// takes the spot where that menu was opened, pinned (mapPlaceRepo). A conversation can be dragged too: it stays
// where it was dropped, as an offset from its repo's hub (saved under its node id, 's:<id>'), so it moves along
// with its repo, and the others make way for it. Dropping a conversation on another repo's group (a dashed ring
// marks it while dragging) moves it there (ui.moveSession, the same as the menu's "Move to workspace"). `g` re-arranges the repos that aren't pinned, `G` unpins every
// repo and conversation too. The camera fits the map when it first shows (and on `0` or `g`), then holds
// still. A resize (the panel opening) keeps the view where it is, held by its top-left corner; whatever that pushes
// off the map (a panel docked on the left or right) brings the view along in one glide once the panel is in place
// (keepIn), so nothing sits under it.
//
// Repo anchors: every repo in the shell's list (state.repoAnchors: [{ root, name, color }], the repo menu's list,
// less removed repos) has its hub and territory even with no conversation on the map, steady like any hub, so
// a repo added by hand can be right-clicked for a new session. A removed repo is not in it, and its
// conversations are not in state.sessions either, so its hub, territory and nodes all leave together.
// Finished conversations: the ones in the shell's "recently finished" strip (state.finishedSessions) are drawn
// as small dim orbs on their repo, steady (no drift, aura, gauge, agents or files). Removing one from the strip
// (its x or the menu's Remove) hides it in the shell, which takes it off both. Gradients are cached per colour (see paint below),
// and the canvas is cleared, not filled, in glass mode so the window's acrylic shows through.
//
//   export function renderMap(el, state, ui)
//     el    container that fills the area under the header; the canvas lives inside it
//     state GET /state JSON
//     ui    { selectedId, setSelected(id), open(id), saveSettings(obj), keys, reveal(req), openUrl(url),
//           contextMenu(target, x, y), setMulti(ids), selectRepo(root) }:
//           the map sets ui.keys.map. reveal / openUrl may be missing (older shell); the map then falls back
//           to POST /reveal and window.open itself. setMulti and selectRepo may be missing too.
//   also exported: mapSelection, setMapSelection, mapLens, setMapLens, setMapReplay (see "Command center")
//
// Acting on nodes: a click picks (a conversation's pick opens the shell's detail panel through
// ui.setSelected). Double-click, a click on the node already picked, or Enter acts on it: a conversation or
// agent opens the conversation, a PR opens on GitHub, a file opens in VS Code. A repo's double-click or Enter
// selects all its conversations (ui.selectRepo); its folder opens from its right-click menu.
// A right-click on a conversation, an agent or a repo calls ui.contextMenu(target, clientX, clientY) with
// { kind: 'session', id } or { kind: 'repo', root, name, color } (the shell's menu, app.js).
//
// New sessions: state.pending (from the shell) lists conversations started in the desktop window that have no
// log yet. Each is drawn at its repo as a hollow node with a steady dashed ring in its account's colour, and
// becomes the real node in place: the shell calls rekeyNode(oldKey, id) when it gets its id, and the node
// keeps its position when /state lists it. A conversation that leaves the map fades out over 400 ms. A handoff's
// pickup that runs here is the old conversation's stand-in (handing: true, keyed by the pickup's id once it has one):
// it keeps the old node and its handing-off look, never the new-session one.
//
// Tests (?fixture=1 or ?debug=1): window.__map = { nodes, stats, debug, comet(fromId, toId), merge(sessionId), sky(hour), skyGL,
// rest(on), battery(on), meteor(), shower(), moon(date), satellites(n), rocket(hubId), event(name, skipSeconds) }. satellites(n) shows n satellites as if n agents ran (null: the
// map's running agents; stats().satellites: { want, shown: [{ x, y, a, blink }] }, CSS px of the window). meteor() sends a shooting star now, shower() a meteor shower
// (not held back by SHOWER_GAP) (stats().meteor: how many streaks show or are about to; meteorIn: ms to the next shooting
// star, null when none is due; showers: how many showers started). rocket(hubId) sends a deploy's rocket up now under
// that hub (null: anywhere) (event(name) starts that space event now, ignoring EVENT_GAP; no name lists the registered ones, null stops
// the one running, skipSeconds: begins that far into an event that has a clock; stats().event: { running, last, nextIn } as name / name / ms, null when none; stats().nebula: the cloud's middle and size in CSS px, its alpha and palette, null when none; stats().asteroids: the field's light direction and the rocks in view, far to near, { x, y, r, blur, a } in CSS px, null when none; stats().lens: the lens's middle and Einstein radius in CSS px, its size share a and its galaxies' light, null when none; ship(escort, skipSeconds) starts the capital ship now, escort: true or false to force the escort (null: a pick); stats().ship: its middle and half-length in CSS px, its alpha, its heading as a unit vector, whether an escort follows and its jump point (the rift: { x, y, h, a, flash, smear } in CSS px, null once shut), null when none; warp(skipSeconds) starts the warp drift now; stats().warp: its stretch share, point and direction, null when none; far(name, skipSeconds) starts that far event now (web/sky-far.js; no name: the kinds, null stops it); stats().far: { running, label, nextIn, at, off, shown: its parts { form, x, y, r, a, en, ex } in CSS px, en and ex how far each has come in and gone out }) (stats().rockets: { flying, launched, shown: [{ x, y, head, trail, puff }] }, the head in CSS px). moon(date) sets the clock the moon and the sky tint go by (null: the real one);
// stats().moon is its phase (0 new, 0.5 full), lit share, waxing, alpha and place (CSS px), shown when visible.
// nodes() lists each node's draw params too (scale, alpha, spin, fin); debug() has the reactions and label
// rectangles; merge('s:<id>') launches that conversation's merge now; stats().heads is where each comet's head is (CSS px); stats().sky says what draws the sky ('webgl2'
// or '2d'), stats().glow what drew the repo nebulae last, stats().fps the draws in the last second, and skyGL() is the sky's WebGL2 context (to lose it). rest(true)
// rests the map as if nobody were there (null: as the desktop says), battery(true) paces it as on battery.
// ?skyHour=<0-24> forces the sky's hour; ?sky2d=1 has the canvas draw the sky, as without WebGL2; ?glow2d=1 has it
// draw only the repo nebulae (to compare the two).
//
// Pacing (Henry: quality over savings, but the frame rate is the map's big cost). Anything fast or short-lived draws
// at every screen refresh: comets, sparks, shooting stars, rockets, ghosts, morphs, births, bumps, kicks, whirls, relay rings, sizes and levels
// still gliding, camera glides and fits, the layout settling, drags, and any change marked dirty (hover, selection,
// wheel, keys, a new state), which also wakes a sleeping loop at once (quickNow, wake). When only the slow ambient
// motion shows, the map draws every k-th refresh (k from the measured refresh, so frames stay even): PACE_LIVELY_FPS
// while a working ring turns, dashes flow or a hub ring turns fast, else PACE_FPS (nothing moves over half a pixel a
// frame), half that on battery; between frames it sleeps (a timer, then a frame callback; paceNext, later). All
// motion runs on elapsed time, so a slower rate never slows anything down, and the sky is drawn only on drawn frames.
// Rest: while nobody used the computer for 5 minutes or the screen is locked (the desktop window says, main.js
// powerMonitor; a browser never rests), the ambient motion holds still where it is and goes on from there after,
// changes still draw at once, and one frame a second keeps the age fades going. Not when the window merely lost
// focus; a hidden or minimized window stops the loop altogether. Reduced motion paces as before (every refresh, drawn
// only on change).
//
// Command center (2026-10-08). The map is also where many conversations are steered at once:
//   Multi-select: Ctrl+click toggles a conversation (or a workspace's hub) into the selection; Ctrl+drag on empty
//     space draws a thin dashed band (fixed alpha) and adds every conversation and workspace hub inside it.
//     Selected ones wear a steady double ring. Dragging a selected hub, or a selected conversation while hubs
//     are selected too, moves the whole selection: every selected hub and the selected conversations; the
//     hubs (I.multiRepos) stay the map's own, the shell only hears about conversations.
//     A plain click goes back to a single pick, Esc clears the selection first. mapSelection() lists the ids,
//     setMapSelection(ids) sets them (the cards' own multi-select), and every change calls ui.setMulti(ids).
//     Right-click on a selected conversation (2+ selected) calls ui.contextMenu({ kind: 'sessions', ids }).
//   Teams (state.teams): members are tied by a soft braided double curve in the team's colour (fixed alpha)
//     with the team's name on a pill; hover shows the order and the last messages, right-click calls
//     ui.contextMenu({ kind: 'team', id }). A team message (a feed entry with `to`) travels as a comet from
//     one member to the other along that link, and a new order (a team's `at` changes) sends one comet from
//     the pill to each member. A team with a lead (team.lead: chain of command) is drawn as spokes from the lead
//     to each member instead of a link between every two, the lead's node wears a small ★ badge in the team's
//     colour, and the pill reads "★ <lead> · <team>".
//   Conflicts (state.conflicts): nodes like the shared-file ones, tied to their conversations by dashed
//     lines: a branch glyph (two on one branch, gold), a folder glyph (two live in one worktree, red) or a
//     '#nnn' tag (two migrations with one number, red). Right-click on one, or on a shared-file node, calls
//     ui.contextMenu({ kind: 'conflict', id, kind2, label, sessions, rel?, root?, files? }).
//   Parity (s.parity): a dotted line from the web side (cyan) to the app side (mint) between partners,
//     "web ↔ app" on hover; a conversation that changed one side only has a small hollow ghost orb beside
//     it on a dashed line, with "no app change" (or "no web change").
//   Ship to phones: a PR's tooltip and ship row show the 'app' step (eas update / build / submit and the
//     platforms), its colour counts it, and the PR wears a small phone badge in that step's colour.
//   Handoffs: a faint arrowed line from the conversation it was picked up from (s.pickedUpFrom, when on the
//     map, finished ones too), and a small tick on the memory gauge where the handoff limit is.
//   Worktrees (state.worktrees): tiny satellites on an outer ring of their repo's hub, only for the ones a live
//     conversation works in (idle ones are noise). Hover one for its name, branch and last commit; the hub's
//     tooltip counts them all and lists the stale ones (no commit for 3 days).
//   Lenses: setMapLens(name) / mapLens(), `k` cycles: state (the usual looks), cost (orb size and colour by
//     cost), account (A / B colours), idle (cyan when fresh, fading toward faint with time since its last
//     activity) and context (green, gold, red by context used). Saved as settings.mapLens. A lens change
//     morphs like a change of state.
//   Saved views: Shift+1..9 keeps the view (its centre in world units and its scale), 1..9 glides back to it;
//     settings.mapViews (localStorage fv.mapViews when the server doesn't keep them).
//   The view itself: where you were looking (the world point at the map's top-left corner, and the scale) is kept
//     as settings.mapCamera whenever it changes, and the map opens there again after a reload or a restart instead
//     of fitting everything (unless nothing would be on screen there; 0 recenters).
//   `n` / `N`: the next / previous conversation that needs you, picked and glided to the middle.
//   Overlay: ./map-overlay.js, when present, is mounted on the map's container with mountMapOverlay(el, API)
//     (see overlayApi) and gets frame(now) every frame, the keys the map doesn't take, and destroy(). It draws
//     the bots put on the map too (map-bots.js, state.bots map / watches); mapWorldAt gives "Add bot" its spot. Their
//     names are the map's own labels (overlayApi botSpots: drawLabels draws them as a workspace's, and keeps the
//     other labels off the mascots).
//   Replay: setMapReplay(on). While on, the shell feeds the map a state rebuilt from the timeline: nothing
//     is born or saved (spots, made during replay, are forgotten when it ends), and comets run on state.now.

// colours and fonts follow the shell's design tokens (app.css); the canvas can't read CSS variables
// per frame, so the values are repeated here
import { FAR_KINDS } from './sky-far.js';

const COL = {
  bg: '#0a0c13', text: '#eef0fa', dim: '#8a92b2', faint: '#4c5372',
  ember: '#ff6a2b', gold: '#ffc24a', rose: '#ff4d8d', violet: '#a47bff', cyan: '#3fd8ff',
  mint: '#3dffa8', red: '#ff4d5e', accA: '#3fb950', accB: '#d97757', accC: '#58a6ff',
};
const UI = "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif";
const DISPLAY = "'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif";
const MONO = "'Cascadia Mono', Consolas, monospace";
const ACC_FONT = () => `700 ${8.5 * (I.sf || 1)}px ${UI}`;
const HOLE = 'rgba(14,17,27,0.92)';        // inside of a hollow node, over the glass or the solid page
const PILL_BG = 'rgba(18,21,32,0.72)', PILL_EDGE = 'rgba(255,255,255,0.07)', LABEL_HALO = 'rgba(10,12,19,0.55)';
// DOM overlays (tooltip, legend, hint) use the shell's CSS variables, with these values as fallbacks
const CSS_UI = `var(--font-ui, ${UI})`, CSS_MONO = `var(--font-mono, ${MONO})`;
const GLASS_BOX = 'background:var(--float-bg, var(--glass-bg-strong, rgba(18,21,32,0.78)));border:1px solid var(--glass-edge, rgba(255,255,255,0.07));' +
  'box-shadow:inset 0 1px 0 var(--glass-highlight, rgba(255,255,255,0.10)),0 10px 30px rgba(0,0,0,0.35);' +
  'backdrop-filter:blur(18px) saturate(1.3);-webkit-backdrop-filter:blur(18px) saturate(1.3);' +
  'color:var(--text, #eef0fa);font-variant-numeric:tabular-nums;';
// the legend's edges: under the overlay's lens chips (map-overlay.js, top 12 + ~34) and above its replay clock
// (bottom 14 + 32) and the replay bar
const LEGEND_TOP = 56, LEGEND_LOW = 72;
const FADE_MS = 10 * 60e3;          // recent-work paths fade out over ten minutes
const MAX_RECENT = 14;              // recent files drawn per conversation
const MAX_AGENTS = 16;              // agents drawn per conversation
const ZMIN = 0.2, ZMAX = 6;

// world-space layout constants
const CHARGE = { session: 100, repo: 115, pr: 30, clash: 42, conflict: 42, recent: 20 };
const MASS = { session: 3, repo: 5, pr: 1.2, clash: 1.5, conflict: 1.5, recent: 1 };
const REST = { repo: 115, pr: 42, clash: 85, conflict: 80, recent: 55 };
// the ring a repo holds its conversations on (world units): wider with more of them, so their labels have room. Henry
// kept dragging new ones out from the old 70 + 17n (a median of ~280 from the hub), so they start out there
const ringR = (repo) => 150 + 25 * repo.sessions.length;
// hard spacing (Henry: removing a repo or a conversation must never leave things crowded; the canvas is big):
// a repo's whole group keeps CLUSTER_GAP clear of every other group, nodes of different repos keep APART_OTHER,
// conversations of one repo keep APART_SAME. Enforced by moving positions, so it holds after the layout settles.
const CLUSTER_GAP = 90, CLUSTER_PAD = 45, APART_OTHER = 120, APART_SAME = 56;

// motion
const TAU = Math.PI * 2;
const COMET_MS = 900;               // travel time along an edge
const COMET_TAIL = 6, COMET_GAP = 0.045; // tail dots and their spacing (fraction of the trip)
const COMET_MAX = 60;               // concurrent comets; the oldest are dropped
const COMET_STAGGER = 80;           // ms between launches when the feed arrives in a burst
const COMET_MAX_AGE = 10e3;         // feed entries older than this never launch (a re-shown session's history)
// a merge launch (see "Merge launch" at the top): the big comet's trip, tail dots, their spacing and head radius
const BIG_MS = 1400, BIG_TAIL = 16, BIG_GAP = 0.024, BIG_HEAD = 3.8;
// the soft light under a comet (Henry: "glow under the dots that travel through the trails"): its radius in head
// radii (small, big comet), peak alpha, how many tail dots after the head get a weaker one (each GLOW_FALL of the
// one before, GLOW_TAIL_R of the head's radius), and the side of the cached sprite it is drawn from (device px)
const GLOW_R = 3.6, BIG_GLOW_R = 4.6, GLOW_A = 0.6, GLOW_TAIL = 2, GLOW_FALL = 0.5, GLOW_TAIL_R = 0.75, GLOW_PX = 64;
const WHIRL_MS = 1200;              // the hub's extra full turn as it lands, easing out
// its sparks: how many, their flight, how far they get (hub radii; every other one less), start radius, and how
// far the ring curls round on the way (radians), so it reads as a pinwheel
const SPARKS = 16, SPARK_MS = 1000, SPARK_REACH = 4.4, SPARK_R = 2.4, SPARK_CURL = 0.55;
const MERGE_MAX_AGE = 30e3;         // a 'merged' alert older than this is history (the map was hidden)
const MERGE_STAGGER = 400;          // ms between launches when several merges arrive in one state
const RING_DOTS = 18, RING_TURN_MS = 12e3;
const ORBIT_TURN_MS = 40e3;         // running agents: one turn around their conversation
const DRIFT_PX = 3;                 // node drift amplitude at zoom 1
const KEEP_SETTLE_MS = 160, KEEP_PAD = 56; // keepIn: once the map's box holds still this long; px kept from its edge
const FLOW_PX_S = 16;               // recent-work dash flow speed
const AURA_MIN = 14, AURA_MAX = 42, AURA_CALLS = 60, AURA_ALPHA = 0.17;
// repo glow: one soft field per repo, into which each of its nodes (the hub, its conversations, their PRs) puts a
// puff: a core and NEB_LOBES lobes that wander NEB_WANDER of the puff's radius and breathe NEB_BREATHE in scale, once
// per NEB_PERIOD seconds (min, spread). Puffs add up (clamped), so near nodes melt into one cloud that grows with the
// group, a node far off keeps a small cloud of its own, and the empty space between them stays dark. The field is
// added up at NEB_RES of the screen's size (on the graphics card in half floats, see "The repo glows" by drawSkyGL;
// else white on a canvas), tinted the repo's colour (one lit spot per puff NEB_LIGHT of the way to white) and laid
// on the map at NEB_A. A puff: [world radius, screen px added (x ks), strength]; a finished
// conversation's is NEB_DONE as strong. Puffs fade in and out over about NEB_FADE_MS. Alpha moves only then.
const NEB_RES = 1 / 3, NEB_A = 0.46, NEB_LIGHT = 0.32, NEB_LIT_A = 0.5, NEB_DONE = 0.55, NEB_FADE_MS = 700;
const NEB_PUFF = { repo: [80, 28, 0.55], session: [58, 20, 0.42], pr: [34, 10, 0.3] };
const NEB_LOBES = 2, NEB_OFF = [0.3, 0.46], NEB_SIZE = [0.6, 0.76], NEB_LOBE_A = 0.6, NEB_REACH = 1.5;
const NEB_WANDER = 0.12, NEB_BREATHE = 0.08, NEB_PERIOD = [40, 50];
// its look: the cloud's edge turns NEB_EDGE_HUE degrees from the repo's colour (orange to rose, blue to teal, violet to
// indigo), the middle keeps the colour; NEB_GRAIN of a two-layer noise is cut out of it so it reads as wisps and
// dust, not a smooth blob (layers NEB_NOISE world units a tile, drifting NEB_NOISE_DRIFT units a second, pinned to
// the map so they move with a pan or zoom), then each puff's middle is put back (NEB_HEART: [radius of the puff's,
// strength x its own]); it is laid on the map with 'screen', so it adds light and never dulls.
const NEB_EDGE_HUE = -38, NEB_EDGE_DARK = 0.12, NEB_GRAIN = 0.5, NEB_NOISE = [400, 170], NEB_NOISE_DRIFT = [3.2, -5];
const NEB_HEART = [0.5, 0.9];
const BUSY = new Set(['WORKING', 'AGENTS']);
const DASH_NONE = [], DASH_READ = [2, 3], DASH_WROTE_FLOW = [8, 3], DASH_CLASH = [6, 4], DASH_FRESH = [2, 2];
const PUSH_RE = /\bgit\s+push\b|\bgh\s+pr\b|\bpush(ed)?\s+the\s+branch\b|\bopen(ed)?\s+(the|a)\s+pr\b/i;
const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
// ease-out with a slight overshoot, for things growing in
const backOut = (u) => { const c = 1.2, v = u - 1; return 1 + (c + 1) * v * v * v + c * v * v; };

// repo hubs: a faceted hexagon core, a ring of arc segments that turns once per HUB_TURN_MS, and satellite ticks.
// An arriving comet nudges the hub with MOTION only: a scale bump (at most one per BUMP_GAP ms) and a rotation
// kick of the ring that accumulates and eases in. Alpha and colours never change.
const HUB_TURN_MS = 20e3, HUB_RING = 1.5, HUB_TICKS = 1.9, HUB_SEGS = 6;
const BUMP_MS = 350, BUMP_UP = 0.15, BUMP_GAP = 250, KICK = Math.PI / 6, KICK_EASE_MS = 140;
const HUB_R = 10, SAT_RING = 2.4, SAT_MAX = 10, SAT_TURN_MS = 30e3, HUB_HALO_ALPHA = 0.16;
const WT_RING = 3.45;               // worktree satellites: their ring, in core radii
// transitions: a look morphs over MORPH_MS; new nodes grow in over BIRTH_MS (see "Transitions" at the top)
const MORPH_MS = 700, BIRTH_MS = 650;
const FIN_R = 6.5, FIN_CHARGE_CUT = 50; // finished conversations: smaller, and they push their neighbours less

const NEEDS_YOU = new Set(['ASKING', 'QUESTION', 'STALLED', 'ERROR']);
const GHOST_MS = 650;                // a conversation that leaves the map shrinks and fades out over this
const DASH_NEW = [3, 3];             // a new session's ring (steady, never moving)
const Q_GAP = Math.PI * 50 / 180;    // half the opening at the top of an "asked you" ring (100° in all)
const DASH_HO = [5, 4];              // a handing-off conversation's ring, turning slowly: it is in transit
const HANDOFF_GHOST_MS = 950;        // a handed-off node flies into its pickup and is absorbed over this (a pickup already on the map elsewhere)
const RELAY_MS = 900;                // a picked-up node's violet ring, as it turns from handing off to live
// pacing (see "Pacing" at the top): frames a second when only slow ambient motion shows, calm and lively (a working
// ring turns, dashes flow, a hub ring turns fast), halved on battery; at rest one frame a second for age fades
const PACE_FPS = 20, PACE_LIVELY_FPS = 30, REST_TICK_MS = 1000;
const STEP_NAMES = ['push', 'PR', 'checks', 'merged', 'live'];

// command center (see "Command center" at the top)
const LENSES = ['state', 'cost', 'account', 'idle', 'context'];
const DASH_BAND = [5, 4], DASH_GHOST = [2, 3], DASH_LINK = [3, 4];
const TEAM_ALPHA = 0.42, PARITY_ALPHA = 0.6, TRAIL_ALPHA = 0.26, CONFLICT_LINE_ALPHA = 0.5;
// every node stays wired (Henry): a shared file's node keeps a steady line to each conversation sharing it, and a
// recent file's path never fades below its dot (drawn at 0.14 at least)
const CLASH_LINK_ALPHA = 0.4, PATH_MIN_ALPHA = 0.14;
const GLIDE_MS = 650;               // saved views, n / N and the overlay's panTo glide over this
const IDLE_FULL_MS = 60 * 60e3;     // the idle lens: fully faded after an hour without activity
const WT_MAX = 16;                  // worktree satellites drawn per hub
// the starfield (see "Look"): per layer, how much of the pan it follows, how many stars per STAR_TILE square,
// their radius and alpha ranges (CSS px; fixed per star, only a few bright ones twinkle, TWINKLE_*) and its idle
// drift in px/s.
// A layer's scale is zoom^(depth * STAR_ZOOM); STAR_ZOOM is 0 (Henry 2026-10-14: the sky is far away, so zooming leaves the
// stars, the deep sky's galaxies and the space events exactly where they are; zoomAt keeps them from sliding too).
// Every layer, the deep sky and the space events slide STAR_PAN of the px the pan moves the map, all alike (Henry
// 2026-10-14: "if im moving the camera i should just see more space ... without ... feeling parallax-y"); what only
// makes up for a panel or a resize (holdPan, keepIn's glide) never moves them ("nothing that is happening in the bg
// should be affected by this chat box"). A layer's and an event's depth only tells how it drifts.
// cl: [loose clusters per tile, their share of the stars, spread in px]; sparkle: how many are tiny 4-point sparkles.
// cell: the sky's shader makes this layer itself (STAR_FIELD_GLSL) instead of repeating its tile: at most one star
// per square of cell px, at the tile's density and mix; its stars repeat only every STAR_WRAP px, and its clusters
// become a gentle unevenness (cl's share of the stars gathers in some squares of STAR_SUPER px). STAR_EDGE: how far
// (px) a made star keeps from its cell's edges, so its glow and sparkle are never cut. The canvas repeats all three tiles.
const STAR_TILE = 512, STAR_ZOOM = 0, STAR_PAN = 1, STAR_DIR = [0.83, 0.56], STAR_WRAP = 32768, STAR_SUPER = 256, STAR_EDGE = 5;
const STAR_LAYERS = [
  { depth: 0.15, n: 46, r: [0.45, 0.8], a: [0.12, 0.3], drift: 0.8, seed: 11, cl: [3, 0.45, 34] },
  { depth: 0.35, n: 20, r: [0.6, 1.0], a: [0.16, 0.38], drift: 1.8, seed: 23, cl: [2, 0.35, 46], sparkle: 1, cell: 32, twinkle: 0.15 },
  { depth: 0.6, n: 8, r: [0.8, 1.3], a: [0.22, 0.46], drift: 3.2, seed: 37, sparkle: 3, cell: 64, twinkle: 0.6 },
];
// twinkle (see "Look"; only the layers the shader makes, L.twinkle: the share of their bright stars that do): a star
// whose alpha is in the top TWINKLE_TOP of its layer's range (as its draw goes, u1 u2 >= 1 - TWINKLE_TOP) may twinkle,
// its alpha times 1 + amp (0.6 sin + 0.4 sin), two waves of its own rate (TWINKLE_HZ) and phase; amp TWINKLE_AMP, a
// sparkle's TWINKLE_SPARK, kept within TWINKLE_RANGE of its alpha. Its clock is the map's (I.time), so it holds still
// at rest, under reduced motion and while hidden; rates are whole cycles per TWINKLE_WRAP s, the clock's wrap
const TWINKLE_TOP = 0.5, TWINKLE_HZ = [0.3, 1], TWINKLE_AMP = 0.25, TWINKLE_SPARK = 0.3, TWINKLE_RANGE = [0.7, 1.25];
const TWINKLE_WRAP = 3600;
// sky tint by local hour (see "Look"): [hour, top rgba, bottom (horizon) rgba], blended by minute, wrapping at 24.
const SKY_KEYS = [
  [0, [40, 50, 140, 0.10], [30, 40, 120, 0.08]],
  [4, [40, 50, 140, 0.10], [30, 40, 120, 0.08]],
  [6, [90, 80, 160, 0.06], [255, 150, 140, 0.09]],
  [8, [120, 170, 200, 0.03], [255, 200, 160, 0.04]],
  [10, [120, 200, 210, 0.02], [120, 200, 210, 0.02]],
  [16, [120, 200, 210, 0.02], [120, 200, 210, 0.02]],
  [18, [120, 80, 190, 0.07], [255, 150, 90, 0.10]],
  [20, [90, 60, 170, 0.08], [200, 80, 140, 0.08]],
  [22, [40, 50, 140, 0.10], [30, 40, 120, 0.08]],
];
// star colours from blue-white to amber, [rgb, weight]: mostly white
const STAR_TINT = [['255,255,255', 7], ['236,242,255', 3], ['206,220,255', 1.4], ['218,206,255', 0.6], ['255,244,226', 1.6],
  ['255,226,184', 0.8], ['255,206,152', 0.35]];
const STAR_TINT_SUM = STAR_TINT.reduce((s, t) => s + t[1], 0);
// shooting stars (see "Look"): the next one comes METEOR_GAP ms (a random pick in the range) after the last, or after
// the map is active and awake again; each lasts METEOR_MS, its head moving METEOR_SPEED CSS px/s, its tail fading
// over METEOR_TAIL px (a random pick), at most METEOR_A (as bright as the brightest stars). Its angle is STAR_DIR's,
// turned by up to METEOR_TURN radians, falling to the right or (mirrored) to the left; METEOR_W: its core's width (px)
const METEOR_GAP = [20e3, 60e3], METEOR_MS = 520, METEOR_SPEED = 620, METEOR_TAIL = [80, 140], METEOR_A = 0.5;
const METEOR_TURN = 0.35, METEOR_W = 0.6;
// at most METEOR_N streaks show at once (the sky's shader has a slot for each)
const METEOR_N = 6;
// a merge's meteor shower (see "Look"): SHOWER_N streaks (a random pick), starting within SHOWER_MS of each other
// (each lasting METEOR_MS, so all are gone about 2 s in), at most one shower per SHOWER_GAP ms. The radiant sits
// SHOWER_Y of the map's height down (a random pick) above the hub, kept within SHOWER_X of its width; each streak
// starts SHOWER_FROM px out from it (a pick) and flies straight away from it at SHOWER_FAN radians either side of
// straight down (a pick), at SHOWER_SPEED times METEOR_SPEED and with a SHOWER_TAIL px tail (picks)
const SHOWER_N = [4, 6], SHOWER_MS = 1500, SHOWER_GAP = 10e3, SHOWER_Y = [0.06, 0.2], SHOWER_X = [0.12, 0.88];
const SHOWER_FROM = [24, 120], SHOWER_FAN = 1.25, SHOWER_SPEED = [0.85, 1.25], SHOWER_TAIL = [90, 170];
// the moon (see "Look"): MOON_D its disc's diameter (CSS px), MOON_A its lit side's alpha, MOON_DARK the dark side's
// alpha (it hides the stars behind it a little) and MOON_EARTH its earthshine's light (most near new moon), MOON_HALO
// the glow's alpha at the limb at full moon (it scales with the lit share) out to MOON_HALO_R radii; MOON_LIT,
// MOON_SHINE, MOON_GLOW their rgb. MOON_MARIA: its darker seas, [x, y, radius (in radii, y down), how much darker].
const MOON_D = 26, MOON_A = 0.82, MOON_DARK = 0.32, MOON_EARTH = 0.05, MOON_HALO = 0.13, MOON_HALO_R = 3;
const MOON_LIT = [242, 238, 226], MOON_SHINE = [130, 145, 175], MOON_GLOW = [212, 222, 240];
const MOON_MARIA = [[-0.36, -0.4, 0.28, 0.16], [0.2, -0.36, 0.18, 0.14], [0.36, -0.04, 0.22, 0.15], [0.7, -0.2, 0.11, 0.14],
  [-0.6, 0.06, 0.34, 0.12], [-0.16, 0.46, 0.17, 0.1], [0.55, 0.26, 0.14, 0.12]];
// its path: it rises at MOON_SPAN of the width left of the middle, peaks MOON_TOP of the height from the top and
// sets as far right, MOON_LOW from the top at the horizon; MOON_DAY: the hours it fades out (from, to) in the
// morning and back in (from, to) at dusk; under MOON_MIN lit it is not shown (new moon). Reference new moon and
// synodic month for its phase. MOON_WRAP: the px beyond two windows its slide with the pan wraps at (moonPlace), more
// than its halo is wide, so it never shows at both edges at once.
const MOON_SPAN = 0.4, MOON_TOP = 0.1, MOON_LOW = 0.42, MOON_DAY = [7, 9, 17, 19], MOON_MIN = 0.015, MOON_WRAP = 240;
const MOON_NEW = Date.UTC(2000, 0, 6, 18, 14), MOON_MONTH = 29.530588853;
// lunar eclipses (just for fun): the real total and partial ones 2026-2035 from NASA's catalog
// (eclipse.gsfc.nasa.gov/LEdecade), each [greatest eclipse (TD, NASA's own time), umbral magnitude, partial phase's
// length, totality's length (min; 0 for a partial)]; ECL_DT turns TD into UTC (Delta T, about 72 s these years). The
// contacts follow: U1/U4 half the partial phase either side of greatest, U2/U3 half totality (eclipseTable).
// ECL_RU: the umbra's radius in moon radii; ECL_RED the copper rgb, ECL_TOT its light in totality (the full moon's is
// 1), ECL_PART inside the umbra's edge while the moon is still mostly lit (it looks near black then), ECL_PEN how much
// the penumbra dims the lit face next to the umbra
const LUNAR_ECLIPSES = [['2026-03-03T11:34:52', 1.151, 207, 58], ['2026-08-28T04:14:04', 0.93, 198, 0],
  ['2028-01-12T04:14:13', 0.066, 56, 0], ['2028-07-06T18:20:57', 0.389, 141, 0], ['2028-12-31T16:53:15', 1.246, 209, 71],
  ['2029-06-26T03:23:22', 1.844, 220, 102], ['2029-12-20T22:43:12', 1.117, 213, 54], ['2030-06-15T18:34:34', 0.502, 144, 0],
  ['2032-04-25T15:14:51', 1.191, 211, 66], ['2032-10-18T19:03:40', 1.103, 196, 47], ['2033-04-14T19:13:51', 1.094, 215, 49],
  ['2033-10-08T10:56:23', 1.35, 202, 79], ['2034-09-28T02:47:37', 0.014, 27, 0], ['2035-08-19T01:12:15', 0.104, 77, 0]];
const ECL_DT = 72, ECL_RU = 2.7, ECL_RED = [178, 74, 38], ECL_TOT = 0.5, ECL_PART = 0.1, ECL_PEN = 0.3;
// the deep sky (see "Look"), the sky's deepest layer, under the stars: a texture of DEEP_W x DEEP_H painted once,
// each texel DEEP_PX CSS px, sliding with the pan as the stars do and drifting DEEP_DRIFT px/s; DEEP_A is its brightest
// light. Its star dust is a DUST_T device px tile of DUST_N specks, as bright as DUST_A where the band is densest.
const DEEP_W = 512, DEEP_H = 256, DEEP_PX = 8, DEEP_DEPTH = 0.06, DEEP_DRIFT = 0.3, DEEP_A = 0.07;
const DUST_T = 512, DUST_N = 2600, DUST_A = 0.3;
// [rgb (0-1), centre x, y (texels), radius (texels), strength] of the big dim gas clouds, off the band
const DEEP_CLOUDS = [[[0.62, 0.48, 1], 400, 72, 64, 0.55], [[0.36, 0.7, 0.78], 130, 196, 54, 0.42],
  [[0.86, 0.48, 0.66], 262, 6, 44, 0.32]];
// [centre x, y (texels), radius (texels), tilt (short axis / long), turn (rad), kind, rgb of the arms or haze,
// the core's light] of the far galaxies, off the band and the clouds; lights are shares of the band's brightest
const DEEP_GALAXIES = [[26, 138, 12, 0.62, 0.5, 'spiral', [0.4, 0.48, 0.62], 0.55],
  [210, 216, 8, 0.66, -0.4, 'elliptical', [0.5, 0.45, 0.38], 0.3],
  [488, 108, 10, 0.2, 2.4, 'spiral', [0.4, 0.46, 0.6], 0.45]];
// satellites (see "Look"): at most SAT_N (the sky's shader has a slot for each), each a point SAT_R CSS px across (a
// Gaussian's radius, about a bright star's) of SAT_RGB (0-1, a little warm) at SAT_A, SAT_DAY as bright by day. Its
// path crosses the window (I.moonF) in SAT_CROSS s (a pick), tilted SAT_TILT radians (a pick, either way), between
// SAT_Y of the window's height, starting SAT_PAD px off one side; it fades in and out over SAT_FADE
// ms. Its beacon flashes every SAT_BLINK ms (a pick each), for SAT_FLASH ms, by turns SAT_RED and white, up to
// SAT_FLASH_A over the point and a little wider (SAT_FLASH_R)
// SAT_DEPTH: the fraction of the zoom it follows, the nearest star layer's; it slides with the pan as the sky does
const SAT_DEPTH = STAR_LAYERS[STAR_LAYERS.length - 1].depth;
const SAT_N = 8, SAT_R = 0.75, SAT_RGB = [1, 0.95, 0.86], SAT_A = 0.62, SAT_DAY = 0.45;
const SAT_CROSS = [60, 120], SAT_TILT = [0.06, 0.32], SAT_Y = [0.05, 0.6], SAT_PAD = 12, SAT_FADE = 1500;
const SAT_BLINK = [1500, 2000], SAT_FLASH = 160, SAT_RED = [1, 0.32, 0.26], SAT_FLASH_A = 0.38, SAT_FLASH_R = 1.6;
// space events (see "Look"): the next one comes EVENT_GAP ms (a random pick in the range) after the last ended, or after
// the map is active and awake again (never at once); EVENT_DEPTH: the star layers' depths (far, middle, near) an event
// picks through eventCam(depth), the fraction of the zoom it follows (it slides with the pan as the sky does)
// EVENT_MAX: how many run at once; EVENT_PAIR: the weight a kind gets when it can meet one up (prey for the lens, the lens
// for prey); PREY: the kinds the lens can swallow
const EVENT_GAP = [70e3, 160e3], EVENT_MAX = 3, EVENT_PAIR = 3;
const PREY = ['ship', 'planet'];
// the far events (see "Look", FAR_*; web/sky-far.js is the catalog): the next comes FAR_GAP ms (a pick) after the last
// ended; FAR_N parts drawn at most (the shader has a slot for each); a new one's middle keeps FAR_CLEAR CSS px plus its
// own reach from every orb and hub on screen and FAR_EDGE from the window's edge, the best of FAR_TRIES places;
// its sizes times the window's shorter side over FAR_SCALE_AT (within FAR_SCALE_K) times FAR_SIZE (a pick, so they
// differ), then held so its reach is FAR_REACH_K of that side (Henry, 2026-10-14: "dude that is TINY ... not all of
// them the same but nothing should be that small"); its alphas times FAR_GAIN (at most 1); its life times FAR_LIFE
// ([slow, quick]: "events dont last long"); no caption on screen (Henry, 2026-10-14: "remove them"), sky-events.log
// names each; SKY_OFF_MS: how often the kinds switched off are read again
const FAR_GAP = [35e3, 80e3], FAR_N = 10, FAR_CLEAR = 60, FAR_EDGE = 20, FAR_TRIES = 48, FAR_SCALE_AT = 900, FAR_SCALE_K = [0.8, 2.5];
const FAR_SIZE = [2, 3.5], FAR_REACH_K = [0.09, 0.2], FAR_GAIN = 1.3, FAR_LIFE = [2.5, 1.5];
const SKY_OFF_MS = 120e3;
const EVENT_DEPTH = { far: STAR_LAYERS[0].depth, mid: STAR_LAYERS[Math.floor(STAR_LAYERS.length / 2)].depth, near: SAT_DEPTH };
// the nebula drift (see "Look"): it crosses the window in NEBULA_MS ms (a pick), its long half-axis NEBULA_R of the
// window's longer side, its short one NEBULA_ASPECT times that (a pick), along STAR_DIR turned by up to NEBULA_TURN radians
// (either way round), off the window's middle by up to NEBULA_OFF of its height; NEBULA_A: its densest light (the
// colour's share over the sky; NEBULA_ALPHA of that is alpha, so it adds light more than it covers); NEBULA_FADE
// ms: how long it takes to fade in and out at the ends of its life, which its place already makes unseen. NEBULA_PALETTES:
// [body, wisp, edge] colours (0-1), as the deep sky's clouds and the star tints are
const NEBULA_MS = [80e3, 120e3], NEBULA_R = 0.62, NEBULA_ASPECT = [0.55, 0.8], NEBULA_TURN = 0.5, NEBULA_OFF = 0.3;
const NEBULA_A = 0.17, NEBULA_ALPHA = 0.5, NEBULA_FADE = 6000;
const NEBULA_PALETTES = [
  [[0.34, 0.28, 0.72], [0.66, 0.58, 0.98], [0.96, 0.52, 0.66]], // indigo and violet, a rose edge
  [[0.14, 0.44, 0.66], [0.5, 0.82, 0.92], [0.9, 0.62, 0.36]], // blue-teal and cyan, an amber edge
  [[0.62, 0.24, 0.5], [0.96, 0.6, 0.76], [0.36, 0.56, 0.92]], // rose and magenta, a blue edge
  [[0.6, 0.34, 0.22], [0.96, 0.76, 0.5], [0.42, 0.46, 0.88]], // ember and gold, a blue edge
  [[0.2, 0.32, 0.68], [0.64, 0.8, 1], [0.96, 0.64, 0.5]], // deep blue and ice, a peach edge
];
// the asteroid field (see "Look"): ASTEROID_CLASSES: the sharp rocks by depth (only the far
// class now): how many (a pick), their long radius (CSS px), their speed (CSS px/s, along the stream), their
// spin (rad/s) and the share of the window's width they may start into (their start along the stream, so some are
// already crossing when the field begins). The stream runs along STAR_DIR turned by up to ASTEROID_TURN radians (a rock
// strays ASTEROID_STRAY from it), its rocks off the middle sideways by up to ASTEROID_OFF of the window's height.
// ASTEROID_MS: how long the field lasts (a pick; longer if a close one needs it). ASTEROID_CLOSE_P: the chance of a close one, ASTEROID_CLOSE: its depth (nearer than the nearest star layer), radius,
// speed, spin, edge blur (all CSS px) and the seconds before it arrives (a pick each). ASTEROID_ASPECT: a rock's short
// axis over its long. ASTEROID_FADE s: a rock that starts inside the window fades in over this. Look (0-1 colours):
// ASTEROID_BODY the rock, ASTEROID_RIM the warm light along its lit edge at ASTEROID_RIM_A (the close one's share
// ASTEROID_CLOSE_RIM), ASTEROID_FILL a cool glint on the dark edge at ASTEROID_FILL_A, ASTEROID_DUST the motes at
// ASTEROID_DUST_A round rocks over ASTEROID_DUST_MIN CSS px; ASTEROID_OPACITY how far a rock hides what is behind it
const ASTEROID_N = 12, ASTEROID_MS = [100e3, 140e3];
const ASTEROID_CLASSES = [
  { depth: EVENT_DEPTH.far, n: [6, 8], r: [1.5, 3.1], v: [6, 11], w: 0.12, start: 0.35 },
];
const ASTEROID_TURN = 0.4, ASTEROID_STRAY = 0.1, ASTEROID_OFF = 0.38, ASTEROID_ASPECT = [0.62, 1], ASTEROID_FADE = 7;
const ASTEROID_CLOSE_P = 0; // the close one is off (too big)
const ASTEROID_CLOSE = { depth: 0.85, r: [70, 105], v: [40, 56], w: 0.035, blur: [13, 20], wait: [18, 50] };
const ASTEROID_BODY = [0.125, 0.118, 0.145], ASTEROID_RIM = [1, 0.76, 0.5], ASTEROID_RIM_A = 0.85, ASTEROID_CLOSE_RIM = 0.3;
const ASTEROID_FILL = [0.5, 0.62, 0.98], ASTEROID_FILL_A = 0.1, ASTEROID_DUST = [0.95, 0.82, 0.68], ASTEROID_DUST_A = 0.5;
const ASTEROID_DUST_MIN = 6, ASTEROID_OPACITY = 0.96;
// the gravity lens (see "Look"): it crosses the window in LENS_MS ms (a pick) along STAR_DIR turned by up to LENS_TURN radians
// (either way round), off the window's middle by up to LENS_OFF of its height, at LENS_DEPTH (the middle star layer's). LENS_R: its
// Einstein radius (CSS px, a pick), where the ring forms. A point d from it the sky is looked up LENS_R^2 / d away from the lens,
// in full out to LENS_FULL radii and eased out to nothing by LENS_REACH radii (the shader's lensP). It starts and ends LENS_PAD radii off
// the window, and grows from nothing over LENS_FADE ms at the ends of its life (unseen). LENS_CORE: the dark core's radius
// (radii), LENS_SHADE: how far its soft shade reaches (radii), LENS_DARK: how dark the core is. LENS_RING_R: the accretion ring's
// radius (radii), LENS_RING_W its width (CSS px), LENS_RING_RGB its colour (0-1) at LENS_RING_A, LENS_RING_SIDE how much
// of it is brighter on one side (towards a direction picked for each lens). LENS_SRC: the far galaxies it bends into arcs, each
// with rgb (0-1), sig (size, radii), asp (short axis over long), amp (its light, alpha LENS_SRC_A of that), miss (how far off the
// lens's line it passes, radii; a pick), at (when in the lens's life, 0-1, it lines up behind it; a pick) and w (the sweep, in
// radii, it keeps its light over: its light fades by where it lies). LENS_SWEEP: radii a galaxy slides across the lens in its life
const LENS_DEPTH = EVENT_DEPTH.mid;
const LENS_MS = [90e3, 130e3], LENS_R = [40, 56], LENS_TURN = 0.45, LENS_OFF = 0.3, LENS_PAD = 4.5, LENS_FADE = 6000;
const LENS_FULL = 3, LENS_REACH = 7;
const LENS_CORE = 0.15, LENS_SHADE = 0.55, LENS_DARK = 0.8;
const LENS_RING_R = 0.27, LENS_RING_W = 1.1, LENS_RING_RGB = [1, 0.72, 0.42], LENS_RING_A = 0.22, LENS_RING_SIDE = 0.6;
const LENS_SRC = [
  { rgb: [0.62, 0.76, 1], sig: 0.14, asp: 0.5, amp: 0.4, miss: [0.06, 0.2], at: [0.4, 0.65], w: 0.5 },
  { rgb: [1, 0.78, 0.58], sig: 0.09, asp: 0.65, amp: 0.4, miss: [0.12, 0.3], at: [0.15, 0.35], w: 0.4 },
];
const LENS_SRC_A = 0.55, LENS_SWEEP = 2.6;
// the distant capital ship (see "Look"): it crosses the window in SHIP_MS ms (a pick) at SHIP_DEPTH (the far star layer's), bow
// first, level but for up to SHIP_TILT radians off (either way, and it may go either way round), off the window's
// middle by up to SHIP_OFF of its height. SHIP_R: its half-length (CSS px, a pick; its whole length is twice that). It starts and ends
// off the window and fades in and out over SHIP_FADE ms at the ends of its life (unseen). SHIP_ESCORT_P: the chance of an escort, which
// follows SHIP_ESCORT_BACK half-lengths behind the ship's middle (a pick) and SHIP_ESCORT_SIDE to one side of its path (a pick, either
// side), at SHIP_ESCORT_SCALE of its size (a pick). SHIP_BODY: the hull's colour (rgb 0-1, nearly black), SHIP_LIFT: the faint
// lightening of its top, SHIP_BODY_A: how much of what is behind it the hull hides. SHIP_HAZE: the haze between it and us (rgb 0-1,
// a little darker than the sky), SHIP_HAZE_A: how much of the hull's colour it takes (more low on the hull and on the escort, at most
// SHIP_HAZE_MAX; the rim, windows and engines dim by 0.75 of that), SHIP_HAZE_GLOW: the alpha of its faint veil just outside the hull,
// SHIP_SOFT: the edges' extra softness (device px), SHIP_MIST: how much patches of mist, fixed in the sky as the ship slides
// through them, thin the hull out (0-1). SHIP_LIGHT: the star's direction on the screen (x, y
// down); SHIP_RIM, SHIP_RIM_WARM: the rim light's tint (cool, warmer towards the bow), SHIP_RIM_A: its alpha. SHIP_WINDOW: the windows'
// colour, SHIP_WINDOW_A their alpha, SHIP_WINDOW_P the share of the cells of a row that is lit (the tower's row has three times that;
// the escort a third); SHIP_ENGINE, SHIP_ENGINE_A: the engine glow's colour and alpha. The hull, in units of its half-length with
// x along the ship (-1 the stern, 1 the bow) and y across it (negative up): SHIP_HULL the polygons, SHIP_BOXES [middle x, y, half
// width, half height] added to them, SHIP_NOTCH the same cut out of the whole, SHIP_ROWS the windows' rows' y, SHIP_ENGINES the
// nozzles' glows [x, y]
const SHIP_DEPTH = EVENT_DEPTH.far;
const SHIP_MS = [210e3, 300e3], SHIP_R = [86, 110], SHIP_TILT = 0.2, SHIP_OFF = 0.3, SHIP_FADE = 6000;
const SHIP_ESCORT_P = 0.6, SHIP_ESCORT_BACK = [1.7, 2.2], SHIP_ESCORT_SIDE = [0.12, 0.4], SHIP_ESCORT_SCALE = [0.2, 0.26];
const SHIP_BODY = [0.016, 0.02, 0.03], SHIP_LIFT = [0.03, 0.042, 0.066], SHIP_BODY_A = 0.74, SHIP_LIGHT = [-0.42, -0.91];
const SHIP_HAZE = [0.08, 0.106, 0.13], SHIP_HAZE_A = 0.8, SHIP_HAZE_MAX = 0.95, SHIP_HAZE_GLOW = 0.13, SHIP_SOFT = 2.8;
const SHIP_MIST = 0.35;
const SHIP_RIM = [0.6, 0.72, 1], SHIP_RIM_WARM = [1, 0.84, 0.64], SHIP_RIM_A = 0.16;
const SHIP_WINDOW = [1, 0.78, 0.46], SHIP_WINDOW_A = 0.32, SHIP_WINDOW_P = 0.14, SHIP_ENGINE = [0.6, 0.78, 1], SHIP_ENGINE_A = 0.3;
// its arrival out of hyperspace (see "Look"): the jump point opens SHIP_JUMP_AT of the way across the window along its path (from
// the side it comes in by, a pick) over SHIP_JUMP_OPEN ms, then the bow breaks out. It comes out SHIP_JUMP_B half-lengths ahead
// of where its cruise alone would take it, the lead shrinking with time constant SHIP_JUMP_TAU ms (so it leaves the rift at
// about B / TAU half-lengths a ms and slows to its cruise). The rift stays open SHIP_JUMP_HOLD ms after (the escort comes out
// in that time) and folds shut over SHIP_JUMP_CLOSE ms. SHIP_JUMP_R: the rift's half-height, in the ship's half-lengths;
// SHIP_JUMP_RGB, SHIP_JUMP_CORE: its cloud's blue and its slit's white; SHIP_JUMP_A: its alpha at its brightest (it is as far
// off as the ship, so hazed); SHIP_JUMP_FLASH: the flash's alpha as the bow breaks out; SHIP_JUMP_STREAK: how far the hull
// smears back along its heading as it comes out (in its lengths), fading as the lead does, its blue glow with it (SHIP_JUMP_GLOW:
// that glow's light at the start, over the haze)
const SHIP_JUMP_AT = [0.2, 0.4], SHIP_JUMP_OPEN = 1200, SHIP_JUMP_B = 4, SHIP_JUMP_TAU = 420, SHIP_JUMP_HOLD = 1100, SHIP_JUMP_CLOSE = 1600;
const SHIP_JUMP_R = 0.62, SHIP_JUMP_RGB = [0.34, 0.55, 1], SHIP_JUMP_CORE = [0.84, 0.92, 1], SHIP_JUMP_A = 0.5, SHIP_JUMP_FLASH = 0.38;
const SHIP_JUMP_STREAK = 2.2, SHIP_JUMP_GLOW = 0.5;
const SHIP_HULL = [
  [[-0.9, -0.085], [-0.4, -0.1], [0.3, -0.075], [0.97, -0.014], [1, 0], [0.92, 0.014], [0.3, 0.07], [-0.45, 0.105], [-0.9, 0.1]], // the main wedge
  [[-0.78, -0.09], [-0.7, -0.135], [-0.1, -0.145], [0.2, -0.115], [0.5, -0.06], [0.2, -0.05]], // the stepped upper deck
  [[-0.56, 0.1], [-0.46, 0.15], [0.14, 0.15], [0.36, 0.083], [0.1, 0.08]], // the keel
];
const SHIP_BOXES = [
  [-0.56, -0.165, 0.06, 0.04], [-0.56, -0.218, 0.14, 0.017], [-0.56, -0.252, 0.022, 0.022], [-0.56, -0.3, 0.004, 0.03], // the tower, its bridge, mast and needle
  [0.06, -0.16, 0.07, 0.02], [0.06, -0.19, 0.035, 0.014], [0.06, -0.23, 0.003, 0.03], // the forward block, its top and needle
  [0.25, -0.112, 0.022, 0.014], [0.33, -0.098, 0.016, 0.012], [-0.2, -0.157, 0.026, 0.014], // turrets
  [-0.945, 0.0075, 0.055, 0.0975], [-1.02, -0.043, 0.025, 0.028], [-1.02, 0.06, 0.025, 0.03], // the engine block and two nozzles
];
const SHIP_NOTCH = [[-0.34, -0.136, 0.014, 0.014], [-0.3, -0.136, 0.006, 0.014], [0.62, -0.044, 0.014, 0.012], [0.62, 0.045, 0.015, 0.01],
  [-0.12, 0.152, 0.05, 0.016], [-0.3, 0.14, 0.012, 0.01], [0.28, -0.07, 0.01, 0.01]];
const SHIP_ROWS = [-0.218, -0.03, 0.035, 0.092], SHIP_ENGINES = [[-1.047, -0.043], [-1.047, 0.06]];
// the warp drift (see "Look"): it lasts WARP_MS ms (a pick), easing in over WARP_IN of that and out over WARP_OUT of it
// (smoothstep). WARP_STRETCH: how many times longer than itself the nearest layer's star is drawn at the height of it;
// WARP_LAYER: each star layer's share of that (far to near), WARP_DEEP the deep sky's. The sky is squeezed along a direction
// (STAR_DIR turned by up to WARP_TURN radians, either way) about a point (a pick within WARP_AT of the window's width and
// height, at WARP_DEPTH, the middle star layer's), the direction bending WARP_RADIAL of the way towards pointing away from
// that point
const WARP_DEPTH = EVENT_DEPTH.mid;
const WARP_MS = [1500, 2200], WARP_IN = 0.4, WARP_OUT = 0.45, WARP_STRETCH = 90, WARP_LAYER = [0.3, 0.65, 1], WARP_DEEP = 0.1;
const WARP_TURN = 0.3, WARP_AT = [0.3, 0.7], WARP_RADIAL = 0.3;
// the planet (see "Look"): it crosses the window in PLANET_MS ms (a pick) at PLANET_DEPTH, radius PLANET_R CSS px (a pick),
// along a straight path turned up to PLANET_TURN radians off level (either way, and either way round), off the window's middle
// by up to PLANET_OFF of its height; it spins PLANET_SPIN radians a second (a pick; its clouds PLANET_CLOUD times that), its
// axis tilted up to PLANET_TILT. Its star: PLANET_LIT [low, high] of the light's share towards us (the z of its direction;
// PLANET_BACK_P of the time it is behind, PLANET_BACK). PLANET_RING_P: the chance of rings (a gas or ice giant only),
// PLANET_RING: their inner and outer radius (in the planet's) and how open they are seen (the sine of the view's height over
// them, a pick); PLANET_MOON_P: the chance of a moon, PLANET_MOON: its radius (in the planet's), its orbit's (in the
// planet's) and its period (s), picks. PLANET_HAZE: the share of its colour the far haze takes (SHIP_HAZE), PLANET_A: how
// much of the sky behind it hides, PLANET_GLOW: its air's glow's alpha, PLANET_LIGHT: its day side's brightness. PLANET_KINDS: per kind, [its first colour, its
// second, its air's colour (rgb 0-1), the air's thickness (share of the radius)]: 0 a gas giant, 1 an ocean world, 2 an
// ice giant, 3 a haze world, 4 a rust desert (the shader's planetSurf by number)
const PLANET_DEPTH = EVENT_DEPTH.far;
const PLANET_MS = [130e3, 190e3], PLANET_R = [48, 118], PLANET_TURN = 0.5, PLANET_OFF = 0.3;
const PLANET_SPIN = [0.03, 0.065], PLANET_CLOUD = 1.6, PLANET_TILT = 0.45, PLANET_LIT = [-0.2, 0.62], PLANET_BACK_P = 0.25, PLANET_BACK = [-0.88, -0.55];
const PLANET_RING_P = 0.5, PLANET_RING = { in: [1.25, 1.45], out: [1.9, 2.4], open: [0.14, 0.36] };
const PLANET_MOON_P = 0.55, PLANET_MOON = { r: [0.1, 0.17], d: [1.7, 2.5], per: [45, 80] };
const PLANET_HAZE = 0.34, PLANET_A = 0.95, PLANET_GLOW = 0.55, PLANET_LIGHT = 0.55;
const PLANET_KINDS = [
  [[0.93, 0.83, 0.66], [0.72, 0.46, 0.3], [1, 0.84, 0.62], 0.05], // a gas giant: cream zones, rust belts
  [[0.06, 0.2, 0.46], [0.34, 0.4, 0.22], [0.42, 0.66, 1], 0.085], // an ocean world: deep sea, green-brown land, blue air
  [[0.5, 0.82, 0.92], [0.24, 0.48, 0.82], [0.56, 0.88, 1], 0.075], // an ice giant: cyan, deep blue belts
  [[0.9, 0.62, 0.3], [0.64, 0.4, 0.18], [1, 0.7, 0.36], 0.16], // a haze world: thick orange air
  [[0.74, 0.4, 0.23], [0.46, 0.25, 0.17], [1, 0.64, 0.5], 0.04], // a rust desert: thin pink dust
];
// the space battle (see "Look"): it lasts BATTLE_MS ms (a pick) at BATTLE_DEPTH; its middle within BATTLE_AT of the window's
// width and height (a pick each), its lines along a course turned up to BATTLE_TILT radians off level, BATTLE_GAP half-lengths
// apart (a pick), each ship cruising BATTLE_V CSS px a second (a pick) the opposite way to the other side, the two sides
// starting BATTLE_X half-lengths before their broadside (along the course). A capital's half-length BATTLE_R CSS px (a pick),
// an escort's BATTLE_ESCORT of it, BATTLE_ESCORT_P the chance each side has one (at least one does). The ships come out of
// hyperspace BATTLE_ARRIVE ms apart (a pick each, the second side after the first), then fire: a volley (BATTLE_VOLLEY bolts, a
// pick) every BATTLE_FIRE ms per capital (a pick), its bolts BATTLE_BOLT [length CSS px, speed CSS px/s]; a torpedo every
// BATTLE_TORP ms per side (a pick), BATTLE_TORP_V CSS px/s, BATTLE_PD the chance point defence stops it; BATTLE_FIGHTERS pairs
// (a pick) dogfight, each pair one path, the chaser BATTLE_CHASE s behind, firing a tracer every BATTLE_TRACER ms (a pick),
// BATTLE_DOWN the chance a pair's quarry is shot down. At BATTLE_KILL of its life (a pick) the loser's hull starts to blow up,
// breaking in two BATTLE_BREAK ms later; the survivors leave BATTLE_LEAVE ms after that. BATTLE_SIDES: each side's colour
// (rgb 0-1). At most BATTLE_HULLS hulls (a broken one counts two), BATTLE_STREAKS streaks (bolts, tracers, torpedoes, fighters)
// and BATTLE_BLASTS blasts drawn (the shader has a slot for each)
const BATTLE_DEPTH = EVENT_DEPTH.far;
const BATTLE_MS = [80e3, 110e3], BATTLE_AT = [0.22, 0.78], BATTLE_TILT = 0.22, BATTLE_GAP = [2.6, 3.4], BATTLE_V = [2.2, 3.6], BATTLE_X = [2.4, 3.4];
const BATTLE_R = [32, 46], BATTLE_ESCORT = [0.42, 0.55], BATTLE_ESCORT_P = 0.6, BATTLE_ARRIVE = [900, 1800];
const BATTLE_VOLLEY = [3, 6], BATTLE_FIRE = [1600, 3400], BATTLE_BOLT = [11, 260];
const BATTLE_TORP = [7000, 13000], BATTLE_TORP_V = 70, BATTLE_PD = 0.4;
const BATTLE_FIGHTERS = [2, 4], BATTLE_CHASE = 0.55, BATTLE_TRACER = [500, 1100], BATTLE_DOWN = 0.5;
const BATTLE_KILL = [0.55, 0.66], BATTLE_BREAK = 4200, BATTLE_LEAVE = 7000;
const BATTLE_SIDES = [[0.5, 0.78, 1], [1, 0.46, 0.32]];
const BATTLE_HULLS = 4, BATTLE_STREAKS = 16, BATTLE_BLASTS = 10;
// the devouring (see "Look"): the lens catches the ship or a planet whose middle comes within DEVOUR_REACH of its Einstein
// radii (plus half the prey's size), once DEVOUR_MS (its fall, a pick) and the lens's fade still fit in its life. The prey
// eases off its path over the first DEVOUR_EASE of its fall, winds DEVOUR_TURNS times round as it falls (faster and faster),
// stretches to 1 + DEVOUR_STRETCH times its length and shrinks into the ring; DEVOUR_WIND: how far its stream winds (radians
// per e-fold of its radius), DEVOUR_STREAM its alpha. When it is gone the ring flares to 1 + DEVOUR_RING times its light
// and jets DEVOUR_JET Einstein radii long fire, DEVOUR_JET_A bright, over DEVOUR_FLARE ms. DEVOUR_AIM_P: the chance one
// starting while the other is up is aimed to cross it
const DEVOUR_REACH = 3.4, DEVOUR_MS = [12e3, 16e3], DEVOUR_EASE = 0.22, DEVOUR_TURNS = 1.35, DEVOUR_STRETCH = 2.4;
const DEVOUR_WIND = 1.15, DEVOUR_STREAM = 0.55, DEVOUR_RING = 3, DEVOUR_JET = 4.5, DEVOUR_JET_A = 0.4, DEVOUR_FLARE = 8000, DEVOUR_AIM_P = 0.75;
// a deploy's rocket (see "Look"): at most ROCKET_N at once (the sky's shader has a slot for each). It rises from just
// below the window's bottom edge, under the hub (kept within ROCKET_X of the window's width), for ROCKET_MS (a pick),
// slowing all the way (ease-out, ROCKET_EASE), to ROCKET_TOP of the window's height (a pick); its path leans ROCKET_TILT
// radians (a pick, either way) and bends further that way by ROCKET_BEND of its height at the top (a pick). Its head
// is a soft point ROCKET_HEAD_R CSS px across of ROCKET_HEAD (rgb 0-1) at ROCKET_HEAD_A, flaring and gone over
// ROCKET_POP ms at burnout; its trail, ROCKET_TAIL of the window's height long (a pick), ROCKET_GOLD near the head
// turning ROCKET_ORANGE and faint down it, at most ROCKET_TRAIL_A, wavers ROCKET_WAVE CSS px (more down it) and fades
// over ROCKET_FADE ms after burnout, when ROCKET_PUFF_N sparks fly ROCKET_PUFF_R px out over ROCKET_PUFF_MS. A deploy
// first seen already live goes up only if it went live in the last ROCKET_RECENT ms; ROCKET_SEEN: deploys remembered
const ROCKET_N = 3, ROCKET_X = [0.06, 0.94], ROCKET_MS = [2600, 3400], ROCKET_EASE = 2.2, ROCKET_TOP = [0.45, 0.6];
const ROCKET_TILT = [0.03, 0.12], ROCKET_BEND = [0.06, 0.14], ROCKET_HEAD_R = 1.6, ROCKET_HEAD = [1, 0.95, 0.8], ROCKET_HEAD_A = 0.95;
const ROCKET_POP = 320, ROCKET_TAIL = [0.15, 0.25], ROCKET_GOLD = [1, 0.8, 0.42], ROCKET_ORANGE = [1, 0.46, 0.16], ROCKET_TRAIL_A = 0.75;
const ROCKET_WAVE = 2.5, ROCKET_FADE = 1800, ROCKET_PUFF_N = 7, ROCKET_PUFF_R = 14, ROCKET_PUFF_MS = 700;
const ROCKET_RECENT = 90e3, ROCKET_SEEN = 64;
// the vignette: how dark the sky's corners get (plain, glass), and the dither, in 8-bit levels
const VIG_A = [0.3, 0.16], DITHER = 1;

let I = null; // the one map instance (layout survives tab switches and container swaps)
let pendingMulti = null; // a selection set before the map exists (setMapSelection)
let overlayMod = null; // the overlay module's import, once

// ---------- small helpers ----------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hashNum = (s) => { let h = 7; for (const ch of String(s)) h = (h * 33 + ch.charCodeAt(0)) >>> 0; return (h % 1000) / 1000; };
const ctxColor = (pct) => (pct > 90 ? COL.red : pct >= 70 ? COL.gold : COL.mint);
const ctxPct = (s) => (s.context && s.context.limit ? Math.round((100 * s.context.used) / s.context.limit) : null);
// each Claude account's colour (the same as its Windows Terminal tab); the accounts drawn so far go in the legend
const ACC_COL = { A: COL.accA, B: COL.accB, C: COL.accC, D: '#bc8cff', E: '#e3b341', F: '#f778ba' };
const accSeen = new Set(['A', 'B']);
const accColor = (a) => { const k = typeof a === 'string' && /^[A-Z]$/.test(a) ? a : 'B'; accSeen.add(k); return ACC_COL[k] || COL.dim; };
const lastParts = (rel) => String(rel || '').replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('/');
function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  return Math.floor(s / 3600) + 'h ' + (Math.floor(s / 60) % 60) + 'm ago';
}
// a ship's colour; the 'app' step (phones: eas update / build / submit) counts too: shipping to the phones
// shows gold, and live on the web with the phones not done yet stays violet
function shipColor(ship) {
  if (!ship || !ship.steps || ship.fresh) return COL.faint;
  const st = Object.fromEntries(ship.steps);
  if (ship.steps.some(([, v]) => v === 'fail')) return COL.red;
  if (st.app === 'pending') return COL.gold;
  if (st.live === 'ok' && 'app' in st && st.app !== 'ok') return COL.violet;
  if (st.live === 'ok') return COL.mint;
  if (st.merged === 'ok') return COL.violet;
  if (st.checks === 'pending') return COL.gold;
  if (st.checks === 'ok') return COL.cyan;
  return COL.dim;
}
const STEP_LOOK = { ok: ['◆', COL.mint], pending: ['◈', COL.gold], fail: ['✕', COL.red], na: ['–', COL.faint], none: ['◇', COL.faint] };
// a step's name in the ship row: the app step says what ran and for which phones ("app (update · all)")
function stepName(name, ship) {
  if (name !== 'app' || !ship || !ship.app) return name;
  const a = ship.app;
  return `app (${[a.kind, a.platforms].filter(Boolean).join(' · ') || 'eas'})`;
}

// ---------- lenses: what a conversation's colour (and, for cost, its size) says ----------
// a conversation's context used in %, from /state's context or a replay frame's ctx (a fraction)
function ctxOf(s) {
  const p = ctxPct(s);
  if (p !== null) return p;
  if (typeof s.ctx === 'number' && Number.isFinite(s.ctx)) return Math.round(s.ctx <= 1 ? s.ctx * 100 : s.ctx);
  return null;
}
// a ramp mint -> gold -> red over t in 0..1 (hex, so orb() can build its gradient from it)
function ramp(t) {
  t = clamp(t, 0, 1);
  const q = Math.round(t * 20) / 20; // 21 steps: few cached gradients
  return q < 0.5 ? mixHex(COL.mint, COL.gold, q * 2) : mixHex(COL.gold, COL.red, (q - 0.5) * 2);
}
const costT = (c) => clamp(Math.log10(1 + Math.max(0, c || 0)) / Math.log10(51), 0, 1); // $0 .. $50
function lensColor(lens, s) {
  if (lens === 'cost') return ramp(costT(s.cost));
  if (lens === 'account') return accColor(s.account);
  if (lens === 'idle') {
    const age = Date.now() - I.skew - (s.last || 0);
    return mixHex(COL.cyan, COL.faint, Math.round(clamp(age / IDLE_FULL_MS, 0, 1) * 20) / 20);
  }
  if (lens === 'context') { const p = ctxOf(s); return p === null ? COL.dim : ramp(p / 100); }
  return s.hue || COL.cyan;
}
// the small readout under a conversation's name in a lens, or null
function lensText(lens, s) {
  if (lens === 'cost') return '$' + (s.cost || 0).toFixed(2);
  if (lens === 'idle') return s.last ? ago(Date.now() - I.skew - s.last).replace(' ago', '') : null;
  if (lens === 'context') { const p = ctxOf(s); return p === null ? null : p + '%'; }
  return null;
}

// ---------- public entry ----------
export function renderMap(el, state, ui) {
  if (!el || !state) return;
  if (!I) I = createInstance(state);
  if (I.el !== el) attach(el);
  I.ui = ui || {};
  I.state = state;
  I.skew = Date.now() - (state.now || Date.now());
  I.deploy = deployByRepo(state);
  if (!I.W) { const r = el.getBoundingClientRect(); I.W = Math.round(r.width); I.H = Math.round(r.height); I.sized = false; }
  syncSettings(state.settings || {});
  syncSpots(state.settings || {});
  if (I.spotsDue) sendSpots(); // a nudge's save, now that what other screens moved is in
  // a workspace picked from the header's menu (or one more of several shown): the view recenters on what's shown now, as 0 does
  const st = state.settings || {};
  const repo = [st.repo || '', ...(Array.isArray(st.repos) ? st.repos : [])].join('|').toLowerCase();
  if (I.repoSeen !== undefined && I.repoSeen !== repo) recenter(2500);
  I.repoSeen = repo;
  rebuild();
  ingestFeed(state);
  ingestTeams(state);
  ingestMerges(state);
  ingestDeploys(state);
  syncSelection();
  start();
}

// The other views (Cards, Wall, Projects, Bots) call this on every draw: the sky goes on behind them, as the page's
// backdrop (see ensureSky), with a satellite for each running agent of the conversations shown, a meteor shower for a
// merge and a rocket for a deploy going live. The map itself waits for the Map to show again (renderMap).
export function renderSky(state, ui) {
  if (!state || typeof document === 'undefined') return;
  if (!I) { I = createInstance(state); I.ui = ui || {}; }
  ensureSky();
  if (active()) return; // the Map shows: renderMap keeps it all
  I.skew = Date.now() - (state.now || Date.now());
  I.satRun = satRunOf(state);
  ingestMerges(state, true);
  ingestDeploys(state, true);
  startLoop();
}
// the running agents of the conversations the map would show, keyed as their nodes are (rebuild), for the satellites
function satRunOf(state) {
  const fin = Array.isArray(state.finishedSessions) ? new Set(state.finishedSessions.map((s) => s && s.id)) : null, out = [];
  for (const s of visibleSessions(state)) {
    if (!s || (fin && fin.has(s.id) && s.state === 'DONE')) continue;
    for (const a of (s.agents || []).slice(-MAX_AGENTS)) if (a && a.state === 'run') out.push(`a:${s.id}:${a.id}`);
  }
  return out;
}

// a repo's production deploy, by hub id: building (any build running), failed (the newest one failed), else
// clean (the newest went live, or none in the last 3 hours). Only repos that deploy at all (state.deployRepos,
// plus any with a deploy listed) get one; d is the deploy behind it (null when clean with none recent).
function deployByRepo(state) {
  const out = new Map();
  for (const root of Array.isArray(state.deployRepos) ? state.deployRepos : []) if (root) out.set(repoId(root), { state: 'clean', d: null });
  // state.deploys: building first, then newest, so the first one seen per repo decides
  for (const d of Array.isArray(state.deploys) ? state.deploys : []) {
    if (!d || !d.root) continue;
    const id = repoId(d.root), cur = out.get(id);
    if (cur && cur.d) continue;
    out.set(id, { state: d.state === 'building' ? 'building' : d.state === 'failed' ? 'failed' : 'clean', d });
  }
  return out;
}

// ---------- command center: selection, lens, views, replay ----------
export function mapSelection() { return I ? [...I.multi] : pendingMulti ? [...pendingMulti] : []; }
// the shell sets the selection (the cards' multi-select); it doesn't call ui.setMulti back
export function setMapSelection(ids) {
  const list = Array.isArray(ids) ? ids.filter((x) => typeof x === 'string' && x) : [];
  if (!I) { pendingMulti = new Set(list); return; }
  I.multi = new Set(list);
  if (!list.length) I.multiRepos = new Set(); // cleared (Esc, the menu's Clear selection): its workspaces too
  I.dirty = true;
}
function setMulti(set) {
  I.multi = set;
  I.dirty = true;
  try { I.ui.setMulti && I.ui.setMulti([...set]); } catch (err) { console.error(err); }
}
function clearMulti() {
  if (I.multiRepos.size) { I.multiRepos = new Set(); I.dirty = true; }
  if (I.multi.size) setMulti(new Set());
}

// the picked node, for the shell's Delete key: { kind, sid?, root?, name? } or null
export function mapPicked() {
  const n = I && I.sel ? I.byId.get(I.sel) : null;
  return n ? { kind: n.kind, sid: n.sid || null, root: n.root || null, name: n.name || null } : null;
}
export function mapLens() { return I ? I.lens : 'state'; }
export function setMapLens(name) {
  if (!I || !LENSES.includes(name) || name === I.lens) return;
  I.lens = name;
  I.lensAt = Date.now();
  I.dirty = true;
  try { I.ui.saveSettings && I.ui.saveSettings({ mapLens: name }); } catch { /* shell gone */ }
}

// Replay (the overlay's scrubber): the shell renders the map from a state rebuilt from the timeline. Spots made
// while it runs are forgotten when it ends (the live spots come back), and the comets' seen-list starts over.
export function setMapReplay(on) {
  if (!I) return;
  on = !!on;
  if (on === I.replay) return;
  I.replay = on;
  I.seen.clear();
  I.replayT = null;
  I.comets.length = 0; I.cometQ.length = 0; I.bursts.length = 0; // the scene jumps: what was travelling stops
  I.mergeInit = false; // and merges seen on either side of it are history
  if (on) {
    I.spotsBack = new Map([...I.homeXY].map(([id, h]) => [id, { ...h }]));
    I.feedInit = true; // the first replay state's feed (its last 10 s) travels
  } else {
    if (I.spotsBack) { I.homeXY = I.spotsBack; I.spotsBack = null; I.alpha = Math.max(I.alpha, 0.3); }
    I.feedInit = false; // back live: the live feed is history again
    I.teamAt.clear(); I.teamInit = false;
  }
  I.dirty = true;
}

// mapLens and mapViews from the settings: taken when the saved value changes, and not for a few seconds after a
// change made here (a poll that still carries the old value, or the echo of an earlier save, must not undo it)
const ECHO_MS = 4000;
function syncSettings(set) {
  if (set.mapLens !== I.lensSeen) {
    I.lensSeen = set.mapLens;
    if (LENSES.includes(set.mapLens) && set.mapLens !== I.lens && !(Date.now() - (I.lensAt || 0) < ECHO_MS)) { I.lens = set.mapLens; I.dirty = true; }
  }
  if ('mapViews' in set) {
    const sig = JSON.stringify(set.mapViews || {});
    if (sig !== I.viewsSeen) {
      I.viewsSeen = sig; I.viewsLocal = false;
      if (!(Date.now() - (I.viewsAt || 0) < ECHO_MS)) I.views = cleanViews(set.mapViews);
    }
  } else if (!I.viewsLocal) {
    // a server that doesn't keep them: this browser keeps them
    let v = null;
    try { v = JSON.parse(localStorage.getItem('fv.mapViews') || 'null'); } catch { v = null; }
    I.views = cleanViews(v); I.viewsLocal = true;
  }
}
function cleanViews(v) {
  const out = {};
  if (v && typeof v === 'object') for (const k of '123456789') {
    const x = v[k];
    if (x && [x.x, x.y, x.zoom].every(Number.isFinite) && x.zoom > 0) out[k] = { x: x.x, y: x.y, zoom: x.zoom };
  }
  return out;
}
// Shift+digit: keep the view as its centre in world units and its scale (zoom here is the drawn scale, world to
// screen, so it comes back the same however the camera's fit changed since)
function saveView(d) {
  if (!I.cam) return;
  const [x, y] = toWorld(I.W / 2, I.H / 2);
  I.views[d] = { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, zoom: Math.round(K() * 1000) / 1000 };
  const all = { ...I.views };
  I.viewsAt = Date.now();
  if (I.viewsLocal) { try { localStorage.setItem('fv.mapViews', JSON.stringify(all)); } catch { /* storage off */ } }
  else { try { I.ui.saveSettings && I.ui.saveSettings({ mapViews: all }); } catch { /* shell gone */ } }
  flash(`view ${d} saved`);
}
function jumpView(d) {
  const v = I.views[d];
  if (!v || !I.cam) { flash(`no view ${d} yet · Shift+${d} saves one`); return; }
  glideTo(v.x, v.y, v.zoom / (I.cam.fit || 1));
}
// a short note at the bottom of the map (saved views), gone after a moment; fixed alpha, no animation
function flash(text) {
  if (!I.noteEl) return;
  I.noteEl.textContent = text;
  I.noteEl.style.display = 'block';
  clearTimeout(I.noteTimer);
  I.noteTimer = setTimeout(() => { if (I && I.noteEl) I.noteEl.style.display = 'none'; }, 1600);
}

// glide the view so the world point (x, y) sits in the middle, at zoom z (the user's zoom factor; default: as is);
// hold: the glide only makes up for a panel (keepIn), so the sky does not move with it (holdPan)
function glideTo(x, y, z, hold) {
  if (!I.cam || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const tz = clamp(Number.isFinite(z) && z > 0 ? z : I.zoom, ZMIN, ZMAX);
  const to = { x: x - I.cam.cx, y: y - I.cam.cy, z: tz };
  I.camUntil = -1; // the camera holds still: the glide decides (not 0: the next poll's rebuild would start a fit)
  if (I.still) {
    if (hold) holdPan(to.x - I.pan.x, to.y - I.pan.y);
    I.pan = { x: to.x, y: to.y }; I.zoom = to.z; I.glide = null; saveZoomSoon(); I.dirty = true; return;
  }
  I.glide = { from: { x: I.pan.x, y: I.pan.y, z: I.zoom }, to, at: performance.now(), hold: !!hold };
  I.dirty = true;
}
function stepGlide(now) {
  const g = I.glide;
  if (!g) return false;
  const u = clamp((now - g.at) / GLIDE_MS, 0, 1), e = ease(u);
  if (g.hold) holdPan(g.from.x + (g.to.x - g.from.x) * e - I.pan.x, g.from.y + (g.to.y - g.from.y) * e - I.pan.y);
  I.pan.x = g.from.x + (g.to.x - g.from.x) * e;
  I.pan.y = g.from.y + (g.to.y - g.from.y) * e;
  I.zoom = g.from.z * Math.pow(g.to.z / g.from.z, e);
  if (u >= 1) { I.glide = null; saveZoomSoon(); }
  return true;
}
function saveZoomSoon() {
  clearTimeout(I.saveTimer);
  I.saveTimer = setTimeout(() => { try { I.ui.saveSettings && I.ui.saveSettings({ zoom: Math.round(I.zoom * 1000) / 1000 }); } catch { /* shell gone */ } }, 600);
}

// n / N: the next (previous) conversation that needs you, longest waiting first
function nextNeedsYou(dir) {
  const list = I.nodes.filter((n) => n.kind === 'session' && !n.fin && !n.s.pending && NEEDS_YOU.has(n.s.state))
    .sort((a, b) => (a.s.last || 0) - (b.s.last || 0) || (a.id < b.id ? -1 : 1));
  if (!list.length) { flash('nothing needs you'); return; }
  const i = list.findIndex((n) => n.id === I.sel);
  const n = list[i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length];
  pickAndGlide(n);
}
// pick a node (panel, not a live session) and glide it to the middle
function pickAndGlide(n) {
  if (!n) return;
  I.sel = n.id; I.kbTip = true; I.dirty = true;
  try { I.ui.setSelected && I.ui.setSelected(n.sid || null, 'keys'); } catch { /* shell gone */ }
  const w = worldOf(n);
  if (w) glideTo(w[0], w[1]);
}
// a node's position in world units (agents are placed on screen, so theirs comes back from the screen)
function worldOf(n) {
  if (n.p) return [n.p.x, n.p.y];
  if (n.sx !== undefined && I.cam) return toWorld(n.sx, n.sy);
  return null;
}

// ---------- the overlay (map-overlay.js, optional) ----------
// the API it gets: see "Overlay" at the top. Positions: x, y in world units; sx, sy on the canvas.
function overlayApi() {
  const pt = (a, b) => { const r = [a, b]; r.x = a; r.y = b; return r; }; // [x, y] that also has .x / .y
  return {
    nodes: () => {
      if (!I) return [];
      const out = [];
      for (const n of I.nodes) {
        if (n.sx === undefined) continue;
        const w = worldOf(n) || [0, 0], s = n.s;
        const isS = n.kind === 'session';
        out.push({
          id: n.id, kind: n.kind, x: w[0], y: w[1], sx: n.sx, sy: n.sy, r: n.RG || n.R || 4,
          color: isS ? s.stateColor || s.hue || COL.cyan : nodeColor(n), hue: s ? s.hue || null : n.color || null,
          state: isS ? s.state : n.kind === 'agent' ? n.a.state : null,
          needsYou: !!(isS && !n.fin && !s.pending && NEEDS_YOU.has(s.state)),
          name: isS ? s.name || s.id : n.kind === 'agent' ? n.a.label : n.kind === 'repo' ? n.name : n.kind === 'pr' ? '#' + n.num : n.kind === 'conflict' ? n.k.label : n.kind === 'clash' ? lastParts(n.c.rel) : n.kind === 'recent' ? lastParts(n.f.rel) : n.id,
          sid: n.sid || null, last: isS ? s.last || null : null, fin: !!n.fin, root: n.root || (s && s.repo && s.repo.root) || null,
        });
      }
      return out;
    },
    camera: () => {
      if (!I || !I.cam) return null;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of I.sim || []) { if (!n.p) continue; minX = Math.min(minX, n.p.x); maxX = Math.max(maxX, n.p.x); minY = Math.min(minY, n.p.y); maxY = Math.max(maxY, n.p.y); }
      if (!Number.isFinite(minX)) { minX = minY = -100; maxX = maxY = 100; }
      return {
        pan: { x: I.pan.x, y: I.pan.y }, zoom: I.zoom, W: I.W, H: I.H, k: K(), sf: I.sf || 1, cx: I.cam.cx, cy: I.cam.cy,
        toScreen: (x, y) => pt(...toScreen(x, y)), toWorld: (sx, sy) => pt(...toWorld(sx, sy)),
        bounds: { minX, minY, maxX, maxY },
      };
    },
    panTo: (x, y, zoom) => { if (I) glideTo(x, y, zoom); },
    select: (id) => {
      if (!I) return false;
      const n = I.byId.get(id) || I.byId.get('s:' + id);
      if (!n) return false;
      clearMulti();
      I.sel = n.id; I.kbTip = true; I.dirty = true;
      try { I.ui.setSelected && I.ui.setSelected(n.sid || null, 'keys'); } catch { /* shell gone */ }
      return true;
    },
    lens: () => mapLens(),
    setLens: (name) => setMapLens(name),
    lenses: () => LENSES.slice(),
    state: () => (I ? I.state : null),
    replay: () => !!(I && I.replay),
    // the shell's ui (map-bots.js: a bot's menu, placeBot, watchBot, openBotChat, pickBot)
    ui: () => (I ? I.ui : null),
    // where map-bots.js drew each bot's mascot ([{ id, x, y, r, name, color, watching, live, must }], CSS px): their
    // names are labels of the map's own (drawLabels), and the other labels keep off them. Drawn again only on a change
    botSpots: (list) => {
      if (!I) return;
      const a = Array.isArray(list) ? list : [];
      const sig = a.map((b) => `${b.id}|${Math.round(b.x)}|${Math.round(b.y)}|${Math.round(b.r)}|${b.name}|${b.color}|${b.watching}|${b.must ? 1 : 0}`).join(';');
      if (sig === I.botSig) return;
      I.botSig = sig; I.botSpots = a; I.dirty = true;
    },
  };
}
// a non-conversation node's colour (the overlay's minimap)
function nodeColor(n) {
  if (n.kind === 'repo') return n.color || COL.dim;
  if (n.kind === 'pr') return shipColor(n.ship);
  if (n.kind === 'clash') return n.c.writers >= 2 ? COL.red : COL.gold;
  if (n.kind === 'conflict') return conflictColor(n.k);
  if (n.kind === 'agent') return n.a.state === 'fail' ? COL.red : n.s.hue || COL.cyan;
  if (n.kind === 'recent') return n.s.hue || COL.dim;
  return COL.dim;
}
const conflictColor = (k) => (k.kind === 'branch' ? COL.gold : COL.red);
function mountOverlay(el) {
  if (I.overlay) { try { I.overlay.destroy(); } catch (err) { console.error(err); } I.overlay = null; }
  if (!overlayMod) overlayMod = import('./map-overlay.js').catch(() => null);
  const inst = I;
  overlayMod.then((m) => {
    if (!m || typeof m.mountMapOverlay !== 'function' || I !== inst || I.el !== el || I.overlay) return;
    try { I.overlay = m.mountMapOverlay(el, overlayApi()) || null; } catch (err) { console.error(err); I.overlay = null; }
    I.dirty = true;
  }).catch(() => {});
}

// timing of the last frames, for the harness: { avgMs, maxMs, frames, comets, sky, fps, pace } (sky: 'webgl2' or '2d', what
// draws it; fps: draws in the last second; pace: the ambient rate paceNext picked, the refresh ms, at rest, on battery;
// moon: see __map.moon; skyDraws: the sky's shader passes so far, which stays put while nothing in the sky changes)
export function mapStats() {
  if (!I) return null;
  const s = I.stats;
  return { avgMs: s.n ? s.sum / s.n : 0, maxMs: s.max, frames: s.frames, comets: I.comets.length, queued: I.cometQ.length,
    heads: cometHeads(), big: I.comets.concat(I.cometQ).filter((c) => c.big).length, bursts: I.bursts.length, sky: I.skyGL && I.skyGL.ok ? 'webgl2' : '2d',
    meteor: I.meteors.length, showers: I.showers, meteorIn: I.meteorAt ? Math.round(I.meteorAt - performance.now()) : null,
    event: { running: [...I.events.keys()], last: I.eventLast, nextIn: I.eventAt ? Math.round(I.eventAt - performance.now()) : null },
    asteroids: (() => { const e = evOf('asteroids'); if (!e) return null;
      return { light: e.ev.light.map((v) => Math.round(v * 100) / 100), shown: asteroidsNow().map((r) => ({ x: Math.round(r.x), y: Math.round(r.y), r: Math.round(r.r * 10) / 10, blur: Math.round(r.blur), a: Math.round(r.a * 1e3) / 1e3 })) }; })(),
    lens: (() => { const l = lensNow(); return l ? { x: Math.round(l.x), y: Math.round(l.y), r: Math.round(l.r * 10) / 10, a: Math.round(l.a * 1e3) / 1e3, src: l.srcs.map((o) => Math.round(o.amp * 1e3) / 1e3),
      feed: l.feed ? { rho: Math.round(l.feed.rho), a: Math.round(l.feed.a * 1e3) / 1e3 } : null, flare: Math.round(l.flare * 1e3) / 1e3, jets: Math.round(l.jl), fed: evOf('lens').ev.fed.map((m) => m.k) } : null; })(),
    planet: (() => { const q = planetNow(); return q ? { x: Math.round(q.x), y: Math.round(q.y), r: Math.round(q.r * 10) / 10, kind: q.kind, ring: !!q.ring, moon: !!q.moon,
      falling: q.fall ? Math.round(q.fall.f * 1e3) / 1e3 : null } : null; })(),
    battle: (() => { const q = battleNow(); return q ? { x: Math.round(q.x), y: Math.round(q.y), reach: Math.round(q.reach), s: Math.round(q.s * 10) / 10, hulls: q.hulls.length,
      streaks: q.streaks.length, blasts: q.blasts.map((b) => b.kind), kill: Math.round(evOf('battle').ev.sKill * 10) / 10, brk: Math.round(evOf('battle').ev.sBreak * 10) / 10 } : null; })(),
    ship: (() => { const q = shipNow(); return q ? { x: Math.round(q.x), y: Math.round(q.y), r: Math.round(q.r * 10) / 10, a: Math.round(q.a * 1e3) / 1e3, dir: [Math.round(q.cs * 1e3) / 1e3, Math.round(q.sn * 1e3) / 1e3], escort: !!q.eo, jump: q.j ? { x: Math.round(q.j.x), y: Math.round(q.j.y), h: Math.round(q.j.h), a: Math.round(q.j.a * 1e3) / 1e3, flash: Math.round(q.j.fl * 1e3) / 1e3, smear: Math.round(q.j.sm * 1e3) / 1e3 } : null } : null; })(),
    warp: (() => { const q = warpNow(); return q ? { a: Math.round(q.a * 1e3) / 1e3, x: Math.round(q.x), y: Math.round(q.y), dir: [Math.round(q.dx * 1e3) / 1e3, Math.round(q.dy * 1e3) / 1e3] } : null; })(),
    far: { running: I.far ? I.far.name : null, label: I.far ? FAR_KINDS.get(I.far.name).label : null, ms: I.far ? I.far.ms : null, nextIn: I.farAt ? Math.round(I.farAt - performance.now()) : null,
      at: I.far ? [Math.round(I.far.x), Math.round(I.far.y)] : null, off: [...I.skyOff],
      shown: farNow().map((q) => ({ form: q.form, x: Math.round(q.x), y: Math.round(q.y), r: Math.round(q.r * 10) / 10, a: Math.round(q.a * 1e3) / 1e3,
        en: Math.round(q.en * 100) / 100, ex: Math.round(q.ex * 100) / 100 })) },
    nebula: (() => { const n = nebulaNow(); return n ? { x: Math.round(n.x), y: Math.round(n.y), r: Math.round(n.r), a: Math.round(n.a * 1e3) / 1e3, pal: n.pal } : null; })(),
    moon: (({ phase, frac, waxing, a, x, y }) => ({ phase: Math.round(phase * 1e4) / 1e4, frac: Math.round(frac * 1e4) / 1e4, waxing, a: Math.round(a * 1e3) / 1e3,
      visible: a > 0, x: Math.round(x), y: Math.round(y) }))((m => ({ ...m, ...moonPlace(m) }))(moonNow())), skyDraws: I.skyGL ? I.skyGL.draws || 0 : 0,
    satellites: { want: satWant().length, shown: satsNow().map((s) => ({ x: Math.round(s.x), y: Math.round(s.y), a: Math.round(s.a * 1e3) / 1e3, blink: Math.round(s.f * 1e3) / 1e3 })) },
    rockets: { flying: I.rockets.length, launched: I.rocketsN, shown: rocketsNow().map((r) => { const [x, y] = rocketHead(r);
      return { x: Math.round(x), y: Math.round(y), head: Math.round(r.ha * 1e3) / 1e3, trail: Math.round(r.ta * 1e3) / 1e3, puff: Math.round(r.puff * 1e3) / 1e3 }; }) },
    glow: I.glowGL ? 'webgl2' : '2d',
    fps: I.pace.draws.filter((t) => t > performance.now() - 1000).length,
    pace: { fps: I.pace.fps, refreshMs: Math.round(I.pace.ms * 100) / 100, quick: I.quick, lively: I.lively, rest: resting(), battery: away.battery } };
}

// node positions on screen, for the harness's click tests: [{ id, kind, x, y, cx, cy, sid, pending, root }]
// (x, y on the canvas; cx, cy in the window's client pixels; wx, wy in the layout's world units). Fading nodes
// are listed with ghost: true.
export function mapNodes() {
  if (!I) return [];
  const r = I.canvas ? I.canvas.getBoundingClientRect() : { left: 0, top: 0 };
  const out = I.nodes.filter((n) => n.sx !== undefined).map((n) => ({
    id: n.id, kind: n.kind, x: n.sx, y: n.sy, cx: r.left + n.sx, cy: r.top + n.sy, sid: n.sid || null, wx: n.p ? n.p.x : null, wy: n.p ? n.p.y : null,
    cl: n.cl || null, pending: !!(n.s && n.s.pending), root: n.root || null, name: n.kind === 'session' ? n.s.name : n.name || null,
    // draw params: the bump scale (1 at rest), the alpha the node was drawn at, a hub's ring angle, finished
    fin: !!n.fin, state: n.kind === 'session' ? n.s.state : null, R: n.R, scale: n.bs || 1, alpha: n.da === undefined ? 1 : n.da, spin: n.spin === undefined ? null : n.spin,
    multi: !!(n.kind === 'session' ? I.multi.has(n.sid) : n.kind === 'repo' && I.multiRepos.has(n.id)),
    // a conversation's look (lookKey) and whether its picked-up ring is spreading now
    ...(n.kind === 'session' ? { look: I.look.get(n.id)?.key || null, relay: !!I.look.get(n.id)?.relay } : {}),
  }));
  for (const g of I.ghosts) out.push({ id: g.n.id, kind: g.n.kind, ghost: true, x: g.n.sx, y: g.n.sy, cx: r.left + g.n.sx, cy: r.top + g.n.sy, sid: g.n.sid || null });
  return out;
}

// the right-click menu's "Unpin": target { kind: 'repo', root } or { kind: 'session', id }
const pinKey = (t) => (!t ? null : t.kind === 'repo' && t.root ? repoId(t.root) : t.kind === 'session' && t.id ? 's:' + t.id : null);
export function mapPinned(t) { const k = I && pinKey(t); return !!(k && I.homeXY.has(k) && I.homeXY.get(k).pin); }
// a repo keeps its spot but may move again; a conversation goes back on its repo's ring
export function mapUnpin(t) {
  const k = I && pinKey(t);
  if (!k || !I.homeXY.has(k)) return;
  if (k.startsWith('s:')) I.homeXY.delete(k); else I.homeXY.get(k).pin = false;
  I.alpha = Math.max(I.alpha, 0.3);
  I.dirty = true;
  saveSpotsSoon(300, true);
}

// the empty-space menu's "Layout" (app.js): 'tidy' gives the workspaces that aren't pinned new spots (the `g` key);
// the others unpin everything and pack the workspaces in rows in that order, each conversation back on its
// workspace's ring. false when the map isn't showing.
export function mapLayout(mode) {
  if (!active() || !I.nodes) return false;
  if (mode === 'tidy') { rearrange(false); return true; }
  const repos = I.nodes.filter((n) => n.kind === 'repo');
  const last = (n) => n.sessions.reduce((t, s) => Math.max(t, s.last || 0), 0);
  const busy = (n) => n.sessions.filter((s) => s.state === 'WORKING' || s.state === 'AGENTS').length;
  const open = (n) => n.sessions.filter((s) => s.state !== 'DONE').length;
  const by = {
    name: (a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base', numeric: true }),
    busy: (a, b) => busy(b) - busy(a) || open(b) - open(a) || last(b) - last(a),
    recent: (a, b) => last(b) - last(a),
    size: (a, b) => b.sessions.length - a.sessions.length || last(b) - last(a),
  }[mode];
  if (by) {
    const order = repos.sort(by).map((n) => n.id);
    I.homeOrder = [...order, ...I.homeOrder.filter((id) => !order.includes(id))];
    I.homeSig = '';
  }
  rearrange(true);
  return true;
}

// "Add workspace" from the map's empty-space menu: the new repo's hub takes the spot where the menu was opened
// (client coordinates), pinned there like a drop, instead of the nearest free spot. false when the map isn't showing.
export function mapPlaceRepo(root, clientX, clientY) {
  if (!active() || !I.cam || !I.canvas || !root || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return false;
  const r = I.canvas.getBoundingClientRect();
  const [x, y] = toWorld(clientX - r.left, clientY - r.top);
  const id = repoId(root);
  I.homeXY.set(id, { x, y, pin: true });
  // a repo that was on the map before (removed, then added back) goes there too
  const p = I.pos.get(id);
  if (p) { p.x = x; p.y = y; p.vx = 0; p.vy = 0; }
  I.alpha = Math.max(I.alpha, 0.3);
  I.dirty = true;
  saveSpotsSoon(300, true);
  return true;
}

// "Add bot" from the map's empty-space menu (app.js): the world spot under a point (client coordinates), where the
// bot's mascot goes (state.bots map); null when the map isn't showing
export function mapWorldAt(clientX, clientY) {
  if (!active() || !I.cam || !I.canvas || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  const r = I.canvas.getBoundingClientRect();
  const [x, y] = toWorld(clientX - r.left, clientY - r.top);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

// Ctrl+V (app.js): the workspace whose group reaches a point on the map (client coordinates), the nearest one,
// or null over empty space or when the map isn't showing
export function mapRepoAt(clientX, clientY) {
  if (!active() || !I.cam || !I.canvas || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return null;
  const r = I.canvas.getBoundingClientRect();
  const [x, y] = toWorld(clientX - r.left, clientY - r.top);
  const ext = groupExt(I.sim);
  let best = null, bd = Infinity;
  for (const n of I.sim) {
    if (n.kind !== 'repo' || !n.p || !n.root) continue;
    const d = Math.hypot(x - n.p.x, y - n.p.y);
    if (d <= Math.max(70, (ext.get(n.id) || 40) * 0.9) && d < bd) { bd = d; best = n; }
  }
  return best ? best.root : null;
}
// a pasted conversation (its key, new-<n> until it has an id) sits where it was pasted, pinned to its repo's
// group like a dropped one; false when the map isn't showing or that repo isn't on it
export function mapPlaceSession(key, root, clientX, clientY) {
  if (!active() || !I.cam || !I.canvas || !key || !root || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return false;
  const hub = I.byId.get(repoId(root)), base = hub && hub.p ? hub.p : I.homeXY.get(repoId(root));
  if (!base) return false;
  const r = I.canvas.getBoundingClientRect();
  const [x, y] = toWorld(clientX - r.left, clientY - r.top);
  I.homeXY.set('s:' + key, { x: x - base.x, y: y - base.y, pin: true });
  I.alpha = Math.max(I.alpha, 0.3);
  I.dirty = true;
  saveSpotsSoon(300, true);
  return true;
}

// for tests: the map's inner numbers
export function mapDebug() {
  if (!I) return null;
  return { nodes: I.nodes.length, drawn: I.nodes.filter((n) => n.sx !== undefined).length, W: I.W, H: I.H, cam: I.cam, running: I.running, sized: I.sized,
    nanPos: [...I.pos.values()].filter((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y)).length, alpha: I.alpha, ghosts: I.ghosts.length, lastDraw: I.lastDraw,
    react: I.react ? Object.fromEntries([...I.react].map(([id, r]) => [id, { hits: r.hits, bumps: r.bumps, kick: r.kT, kickNow: r.kC, whirls: r.whirls }])) : {},
    bursts: I.bursts.map((b) => ({ id: b.id, age: Math.round(performance.now() - b.at) })), mergeN: I.mergeN,
    labels: I.labelRects ? Object.fromEntries(I.labelRects) : {},
    comets: I.comets.concat(I.cometQ).map((c) => c.a + '>' + c.b),
    multi: [...I.multi], lens: I.lens, views: I.views, replay: I.replay, overlay: !!I.overlay, glide: !!I.glide, pan: { ...I.pan }, zoom: I.zoom,
    teams: (I.teams || []).map((t) => ({ id: t.t.id, pairs: t.pairs.length, pill: t.pill || null })),
    links: (I.linkHits || []).map((l) => ({ kind: l.kind, id: l.id, mid: l.mid, pts: l.pts })),
    worktrees: (I.wtHits || []).map((w) => ({ name: w.w.name, x: w.x, y: w.y, live: !!w.w.live, stale: !!w.w.stale })),
    ghosts: (I.parGhosts || []).map((g) => ({ sid: g.n.sid, x: g.x, y: g.y, missing: g.missing })) };
}

// for tests: send a comet from one node to another (ids as mapNodes lists them); it launches now
export function mapComet(from, to) {
  if (!I || !I.byId.has(from) || !I.byId.has(to)) return false;
  const a = I.byId.get(from);
  I.cometQ.push({ a: from, b: to, at: performance.now(), hue: (a.s && a.s.hue) || a.color || COL.cyan });
  I.dirty = true;
  return true;
}
// for tests: a merge launch for a conversation ('s:<id>') now, as if its PR just merged
export function mapMerge(id) {
  return !!(I && typeof id === 'string' && id.startsWith('s:') && launchMerge(id.slice(2), performance.now()));
}
if (typeof location !== 'undefined' && /[?&](fixture|debug)(=|&|$)/.test(location.search)) {
  window.__map = { nodes: () => mapNodes(), stats: () => mapStats(), debug: () => mapDebug(), comet: mapComet, merge: mapMerge,
    sky: (h) => { skyForce = h == null ? null : Number(h); if (I) I.sky = null; }, // force the sky's hour (null: the clock)
    skyGL: () => (I && I.skyGL ? I.skyGL.gl : null), // the sky's WebGL2 context, for a context-loss test
    // rest as if away (true), never (false) or as the desktop says (null); battery(on) as if on battery or not
    rest: (on) => { restForce = on == null ? null : !!on; wake(); return resting(); }, battery: (on) => { away.battery = !!on; wake(); },
    meteor: () => { if (!I) return false; I.meteors.push(meteorMake(performance.now())); I.dirty = true; return true; }, // a shooting star now
    shower: () => !!I && shower(performance.now(), null, true), // a meteor shower now
    // a space event now by name (ignoring EVENT_GAP and EVENT_MAX, beside any running), skip seconds into it; no name: the
    // registered ones; null: stop every one running; a name and skip null: stop that one
    event: (n, skip) => { if (n === undefined) return [...EVENTS.keys()]; if (!I) return false; if (n === null) { eventEnd(); return true; }
      if (skip === null) { eventEnd(n); return true; }
      const ok = eventStart(performance.now(), n); if (ok && skip > 0) eventSkip(n, skip); return ok; },
    // a far event now by name (web/sky-far.js), skip seconds into it; no name: the kinds; null: stop the one running
    far: (n, skip) => { if (n === undefined) return [...FAR_KINDS.keys()]; if (!I) return false; if (n === null) { farEnd(); return true; }
      const ok = farStart(performance.now(), n); if (ok && skip > 0) I.far.at -= skip * 1000; return ok; },
    // the capital ship now, with the escort (true), without (false) or as a pick (null), skip seconds into its crossing
    ship: (escort, skip) => { if (!I) return false; shipForce = escort == null ? null : !!escort; const ok = eventStart(performance.now(), 'ship'); shipForce = null; if (ok && skip > 0) eventSkip('ship', skip); return ok; },
    // a planet now of that kind (PLANET_KINDS' index; null: a pick), skip seconds into its crossing
    planet: (kind, skip) => { if (!I) return false; planetForce = kind == null ? null : Number(kind); const ok = eventStart(performance.now(), 'planet'); planetForce = null; if (ok && skip > 0) eventSkip('planet', skip); return ok; },
    // a space battle now, skip seconds into it
    battle: (skip) => { if (!I) return false; const ok = eventStart(performance.now(), 'battle'); if (ok && skip > 0) eventSkip('battle', skip); return ok; },
    // a black hole and its prey ('ship' or 'planet') laid to meet in view, both skipped on to lead seconds (default 5) before
    // it is caught (lead < 0: caught, and that far into its fall); the seconds skipped, or null when they don't meet
    devour: (kind = 'ship', lead = 5) => {
      if (!I || !PREY.includes(kind)) return null;
      // the lens aimed at the prey, or the prey at the lens
      for (const order of [['lens', kind], [kind, 'lens']]) {
        eventEnd('lens'); eventEnd(kind);
        aimForce = true;
        try { for (const n of order) eventStart(performance.now(), n); } finally { aimForce = false; }
        const L = evOf('lens'), e = evOf(kind), now = performance.now();
        if (!L || !e) return null;
        for (let s = 0; s * 1000 < e.ev.ms; s += 0.25) {
          const lp = lensPose(L.ev, now + s * 1000), q = e.ev.free(now + s * 1000);
          if (!lp || !q || lp.sm < 0.98) continue;
          if (Math.hypot(q.x - lp.x, q.y - lp.y) > DEVOUR_REACH * lp.r + 0.5 * q.r) continue;
          if (lp.x < 0 || lp.x > I.skyW || lp.y < 0 || lp.y > I.skyH) break;
          const k = Math.max(0, s - Math.max(0, lead));
          eventSkip('lens', k); eventSkip(kind, k);
          if (lead < 0) {
            devourStep();
            const F = e.ev.fall;
            if (!F) return null;
            eventSkip('lens', -lead); eventSkip(kind, -lead); F.at += lead * 1000;
            devourStep();
          }
          return k - Math.min(0, lead);
        }
      }
      eventEnd('lens'); eventEnd(kind);
      return null;
    },
    // the warp drift now, skip seconds into it
    warp:(skip) => { if (!I) return false; const ok = eventStart(performance.now(), 'warp'); if (ok && skip > 0) eventSkip('warp', skip); return ok; },
    // the clock the moon and the sky tint go by (a Date, ms or a date string; null: the real one)
    moon: (d) => { moonForce = d == null ? null : new Date(d); if (I) { I.moon = null; I.sky = null; I.dirty = true; } return I ? moonNow() : null; },
    // the moon's clock at that time (as moon) with the sky's hour at midnight, so a full moon is up: a real eclipse
    // then shows (null: both back to the clock); its shadow, or null when none is on
    eclipse: (d) => { skyForce = d == null ? null : 0; window.__map.moon(d); return I && I.moon ? I.moon.ecl : null; },
    // n satellites as if n agents ran (null: the map's running agents); they come and go as they would
    satellites: (n) => { satForce = n == null ? null : Math.max(0, Math.floor(Number(n) || 0)); if (I) I.dirty = true; return satForce; },
    // a deploy's rocket now, under that hub (a repo node id; null: anywhere along the bottom)
    rocket: (id) => !!I && rocketLaunch(performance.now(), id ? I.byId.get(id) : null),
    selection: () => mapSelection(), setSelection: (ids) => setMapSelection(ids), lens: (n) => (n ? setMapLens(n) : mapLens()), replay: (on) => setMapReplay(on),
    // what a point on the canvas hits: { node, over, extra } (ids / kinds)
    hit: (x, y) => { if (!I) return null; const o = hitOver(x, y), n = hitTest(x, y), e = hitExtra(x, y); return { node: n ? n.id : null, over: o ? o.kind + ':' + o.id : null, extra: e ? e.kind + ':' + e.id : null }; } };
}

// node `from` carries on as node `to` ('s:<id>' keys): its position, dragged spot, look and pick move over, so
// nothing leaves or grows in (a new session that got its id, a handoff's pickup taking its predecessor's place)
function carryNode(from, to) {
  for (const m of [I.pos, I.aura, I.look, I.homeXY]) if (m.has(from) && !m.has(to)) { m.set(to, m.get(from)); m.delete(from); }
  if (I.homeXY.has(to)) saveSpotsSoon(300, true);
  if (I.sel === from) I.sel = to;
  if (I.hover === from) I.hover = to;
  for (const [k, v] of [...I.lab]) if (k.startsWith(from + '|')) { I.lab.delete(k); I.lab.set(to + k.slice(from.length), v); }
  // the set of nodes is the same as before: no reheat of the layout, no labels hunting for new spots (rebuild; one
  // id a line, as a file's id has | in it)
  if (I.sig) I.sig = I.sig.split('\n').map((x) => (x === from ? to : x)).sort().join('\n');
}

// a new conversation got its id: its node, position and pick move over, so the real node takes its place
export function rekeyNode(oldKey, id) {
  if (!I || !oldKey || !id) return;
  const from = 's:' + oldKey, to = 's:' + id;
  carryNode(from, to);
  // the drawn node too, so the next rebuild doesn't see it leave (no fade for a node that only changed its key)
  const n = I.byId.get(from);
  if (n && !I.byId.has(to)) { I.byId.delete(from); n.id = to; n.sid = id; I.byId.set(to, n); }
  I.dirty = true;
}

// lets a test page show the legend without a key press
export function toggleMapLegend(on) {
  if (!I) return;
  setLegend(on === undefined ? !I.legend : !!on);
}

function createInstance(state) {
  const z = Number(state && state.settings && state.settings.zoom);
  return {
    el: null, canvas: null, ctx: null, tip: null, legendEl: null, emptyEl: null,
    skyCanvas: null, skyGL: null, // the sky's WebGL2 canvas (off the page) and its state (null: the canvas draws the sky)
    // the page's backdrop (ensureSky): a canvas fixed over the whole window behind every view, its 2D context, its size
    // (CSS px) and dpr; the sky is drawn there, the map's canvas over it is see-through but for the map itself
    skyEl: null, skyCtx: null, skyW: 0, skyH: 0, skyDpr: 0, mapOn: false,
    glowGL: false,            // the last draw's repo glows came with the sky's picture (else the canvas drew them)
    W: 0, H: 0, dpr: 1, mapDpr: 0,
    pos: new Map(),           // node id -> { x, y, vx, vy } in world units, kept between polls
    ang: new Map(),           // agent node id -> current orbit angle (eases toward its slot)
    homeOrder: [],
    homeXY: loadSpots(state), // cluster id -> its spot { x, y, pin }: sticky, saved as settings.mapSpots
    spotsSeen: loadSpots(state), spotsSig: spotsSig(state && state.settings && state.settings.mapSpots), // the server's list as last applied (syncSpots)
    spotsSent: [],            // this screen's ops of the last 15 s ({ op, id, x, y, pin, t }), so their echo is not taken as news
    spotsDue: 0,              // a nudge's save waiting for the next /state (sendSpots)
    spotsTimer: 0,
    nodes: [], byId: new Map(), springs: [], paths: [], clashes: [],
    sig: '', alpha: 0, settledOnce: false,
    cam: null, pan: { x: 0, y: 0 }, zoom: Number.isFinite(z) && z > 0 ? clamp(z, ZMIN, ZMAX) : 1,
    sel: null, hover: null, kbTip: false, legend: false,
    raf: 0, running: false, lastDraw: 0,
    // anything that marks the map dirty wakes a sleeping loop at once (see "Pacing")
    _dirty: true, get dirty() { return this._dirty; }, set dirty(v) { this._dirty = v; if (v) wake(); },
    pace: { ms: 1000 / 60, d: [], ts: 0, chain: false, at: 0, timer: 0, draws: [], fps: PACE_FPS }, // see paceNext
    quick: false, lively: false, // the last draw had a short-lived change going / lively ambient motion
    ghosts: [],               // conversations that just left the map: { n, at }, faded out over GHOST_MS
    drag: null, saveTimer: 0, ui: {}, state: null, skew: 0, measure: new Map(),
    // motion
    time: 0, lastT: 0,        // animation clock in ms (stops while the map is hidden, so nothing jumps)
    aura: new Map(),          // session node id -> eased aura radius (screen px at ks 1)
    look: new Map(),          // session node id -> its look and eased levels (see lookOf)
    agl: new Map(),           // agent node id -> eased running level (1 running, 0 done)
    hub: new Map(),           // repo node id -> its eased presence, activity, spin and satellites (see hubOf)
    orb: new Map(),           // agent node id -> orbit offset (radians), advanced only while running
    lab: new Map(),           // label key -> anchor index it last used, so drifting labels don't hop
    seen: new Map(),          // feed key -> [t...] already seen
    feedInit: false,
    comets: [], cometQ: [], nextLaunch: 0,
    // the streaks showing or about to (meteorMake: the shooting star, a shower's), when the next shooting star is due
    // (0: not yet planned), when the last shower started and how many have
    meteors: [], meteorAt: 0, showerAt: -Infinity, showers: 0,
    // the space events running (name -> { name, at, ev }: eventStep; ev is its own state), the last one's name, when the next is due (0: not yet planned)
    events: new Map(), eventLast: null, eventAt: 0,
    // the far event running ({ name, at, ms, cam, x, y, parts, quick }: farStart), when the next is due (0: not yet
    // planned), the kinds still to show before any repeats (farPick), the kinds switched off (/sky-events) and when to read them again
    far: null, farAt: 0, farBag: [], skyOff: new Set(), skyOffAt: 0,
    sats: new Map(), satRun: [], // the satellites (key -> satMake's), the running agents' keys (rebuild)
    // the deploys' rockets flying (rocketLaunch), how many went up, and the deploys seen (id -> state; ingestDeploys)
    rockets: [], rocketsN: 0, dpSeen: new Map(), dpInit: false,
    bursts: [],               // merge sparks flying out of a hub: { id, at, hue, rot }
    mergeInit: false, mergeN: -Infinity, // the newest alert n seen (ingestMerges)
    reduce: typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null,
    stats: { sum: 0, n: 0, max: 0, frames: 0, ring: new Float32Array(120), i: 0 },
    // command center
    multi: pendingMulti || new Set(), // conversation ids in the multi-selection
    multiRepos: new Set(), // repo hub ids in it (the map's own: Ctrl+drag's band or Ctrl+click on a hub)
    lens: LENSES.includes(state && state.settings && state.settings.mapLens) ? state.settings.mapLens : 'state', lensSeen: undefined,
    views: {}, viewsSeen: null, viewsLocal: false, glide: null,
    savedCam: cleanCam(state && state.settings && state.settings.mapCamera), camSig: '', // the last view (restoreCam)
    teams: [], teamAt: new Map(), teamInit: false, virt: new Map(), // team pills as comet ends ('T:<id>')
    conflicts: [], parity: [], trails: [],
    linkHits: [], wtHits: [], parGhosts: [], hoverX: null, band: null,
    replay: false, replayT: null, spotsBack: null, overlay: null,
  };
}

function attach(el) {
  I.el = el;
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
  el.style.overflow = 'hidden';
  ensureSky();
  if (!I.canvas) {
    const cv = document.createElement('canvas');
    cv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;cursor:default;outline:none';
    I.canvas = cv;
    I.ctx = cv.getContext('2d');
    const tip = document.createElement('div');
    tip.style.cssText = `position:absolute;display:none;pointer-events:none;z-index:5;max-width:340px;${GLASS_BOX}` +
      `border-radius:var(--radius-sm, 8px);padding:9px 12px;font:12px/1.5 ${CSS_UI};overflow-wrap:anywhere`;
    I.tip = tip;
    const lg = document.createElement('div');
    // between the overlay's lens chips (top left) and its replay clock (bottom left), clear of both
    lg.style.cssText = `position:absolute;left:14px;top:${LEGEND_TOP}px;display:none;z-index:4;${GLASS_BOX}` +
      `border-radius:var(--radius, 12px);padding:12px 14px;font:12px/1.5 ${CSS_UI};max-width:min(380px,calc(100% - 28px));` +
      `max-height:calc(100% - ${LEGEND_TOP + LEGEND_LOW}px);overflow:auto;scrollbar-width:thin;scrollbar-color:rgba(138,146,178,0.35) transparent`;
    lg.appendChild(buildLegend());
    I.legendEl = lg;
    const em = document.createElement('div');
    em.style.cssText = `position:absolute;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;gap:6px;pointer-events:none;font:13px ${CSS_UI};color:${COL.dim}`;
    I.emptyEl = em;
    const hint = document.createElement('div');
    hint.style.cssText = `position:absolute;right:14px;bottom:12px;z-index:3;pointer-events:none;font:11px/1 ${CSS_UI};color:${COL.dim};` +
      `background:${PILL_BG};border:1px solid ${PILL_EDGE};border-radius:999px;padding:4px 9px`;
    const kb = document.createElement('b');
    kb.textContent = 'L';
    kb.style.cssText = `font:600 11px/1 ${CSS_MONO};color:${COL.text};margin-right:6px`;
    hint.append(kb, 'legend');
    I.hintEl = hint;
    // a short note (saved views, n with nothing waiting), bottom centre
    const note = document.createElement('div');
    note.style.cssText = `position:absolute;left:50%;bottom:14px;transform:translateX(-50%);display:none;z-index:4;pointer-events:none;${GLASS_BOX}` +
      `border-radius:999px;padding:5px 12px;font:12px/1.3 ${CSS_UI};white-space:nowrap`;
    I.noteEl = note;
    wireMouse(cv);
  }
  el.appendChild(I.canvas);
  el.appendChild(I.emptyEl);
  el.appendChild(I.hintEl);
  el.appendChild(I.noteEl);
  el.appendChild(I.legendEl);
  el.appendChild(I.tip);
  I.W = 0; I.sized = false; // force a resize check
  I.dirty = true;
  mountOverlay(el);
}

const active = () => !!(I && I.el && I.el.isConnected && I.el.getClientRects().length > 0);
const skyOn = () => !!(I && I.skyEl && I.skyEl.isConnected);

// The sky is the page's backdrop (Henry, 2026-10-14: "behind all tabs", and no menu or panel may move it): its own
// canvas, fixed over the whole window under every view (the header, the strips, the panels and the cards are drawn
// over it), so it is laid out in the window's CSS px, never the map's box. The map's canvas, when the Map shows, is
// see-through but for the map's own things. The sky's WebGL2 canvas (drawSkyGL) stays off the page: the backdrop
// copies its picture whenever it drew a new one (skyPaint).
function ensureSky() {
  if (!I.skyCanvas) {
    I.skyCanvas = document.createElement('canvas');
    I.skyGL = sky2d ? null : skyGLMake(I.skyCanvas);
  }
  if (!I.skyEl) {
    const bg = document.createElement('canvas');
    bg.className = 'sky-bg';
    bg.setAttribute('aria-hidden', 'true');
    bg.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;display:block;pointer-events:none;z-index:-1';
    I.skyEl = bg; I.skyCtx = bg.getContext('2d');
    I.skyW = I.skyH = 0; // sized by the next frame (skySize)
  }
  if (!I.skyEl.isConnected && document.body) document.body.prepend(I.skyEl);
}
// the backdrop's size: the window's, worked out each frame (cheap) so a resize lays it again at once
function skySize(dpr) {
  const w = Math.max(1, Math.round(window.innerWidth || 0)), h = Math.max(1, Math.round(window.innerHeight || 0));
  if (w === I.skyW && h === I.skyH && dpr === I.skyDpr) return;
  I.skyW = w; I.skyH = h; I.skyDpr = dpr;
  I.skyEl.width = I.skyCanvas.width = Math.max(1, Math.round(w * dpr));
  I.skyEl.height = I.skyCanvas.height = Math.max(1, Math.round(h * dpr));
  if (I.skyGL) I.skyGL.drawn = false; // a new size clears both, so the sky is drawn again
  I.sky = null;
  // the solid page colour (Edge, no glass) comes from the shell's --bg when it sets one
  try { I.bgFill = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || COL.bg; } catch { I.bgFill = COL.bg; }
  I.dirty = true;
}

// Keys come through the shell's ui.keys.map hook, not a window listener of our own: the shell routes
// keys to the open repo menu, the open-confirm box and the / filter first, and only then to the map.
function start() {
  if (I.ui && I.ui.keys) I.ui.keys.map = onKey;
  startLoop();
}
function startLoop() {
  if (I.running) { if (I.cometQ.length) wake(); return; } // a new state's comets launch now, not after a sleep
  if (document.hidden) return;
  I.running = true;
  I._dirty = true;
  if (I.skyGL) I.skyGL.drawn = false; // and the sky once, after the window was hidden
  I.lastT = 0;
  I.raf = requestAnimationFrame(frame);
}
// the loop stops while the window is hidden; come back without waiting for the next poll
document.addEventListener('visibilitychange', () => { if (I && !document.hidden && (active() || skyOn())) startLoop(); });
function stop() {
  I.running = false;
  cancelAnimationFrame(I.raf); I.raf = 0;
  clearTimeout(I.pace.timer); I.pace.timer = 0;
  I.meteors.length = 0; I.meteorAt = 0; // the next shooting star is planned when the map shows again
  I.events.clear(); I.eventAt = 0; // likewise the next space event
  I.far = null; I.farAt = 0; // and the next far event
  I.rockets.length = 0;
  if (I.tip) I.tip.style.display = 'none';
}
// a sleeping loop (between paced frames, or at rest) draws on the next screen refresh
function wake() {
  if (!I || !I.running || I.raf || !I.pace) return;
  clearTimeout(I.pace.timer); I.pace.timer = 0; I.pace.at = 0;
  I.raf = requestAnimationFrame(frame);
}

// ---------- pacing and rest (see "Pacing" at the top) ----------
// away: the desktop window says when nobody used the computer for 5 minutes or the screen is locked, and when it
// runs on battery (main.js, powerMonitor); a browser only knows its battery. restForce: tests (__map.rest)
const away = { idle: false, locked: false, battery: false };
let restForce = null;
const resting = () => (restForce !== null ? restForce : away.idle || away.locked);
if (typeof window !== 'undefined') {
  const fd = window.fleetDesktop;
  if (fd && typeof fd.onAway === 'function') {
    fd.onAway((a) => {
      const was = resting();
      away.idle = !!(a && a.idle); away.locked = !!(a && a.locked); away.battery = !!(a && a.battery);
      if (I && was !== resting()) wake();
    });
  } else if (typeof navigator !== 'undefined' && typeof navigator.getBattery === 'function') {
    navigator.getBattery().then((b) => {
      const f = () => { away.battery = !b.charging; };
      f(); b.addEventListener('chargingchange', f);
    }).catch(() => {});
  }
  // a key or the mouse here ends an idle rest at once (main.js only looks once a second while idle)
  const back = () => { if (away.idle) { away.idle = false; wake(); } };
  for (const t of ['pointermove', 'pointerdown', 'keydown', 'wheel']) window.addEventListener(t, back, { capture: true, passive: true });
}
// something short-lived is going on (draw at every refresh): a change marked dirty, the layout settling, a comet,
// a shooting star, a fading ghost, merge sparks, a camera glide, a drag or band, a re-arrange, or what the last draw
// saw (I.quick: a morph, birth, bump, kick, whirl, relay ring, or a size or level still gliding)
function quickNow() {
  const sky = I._dirty || I.meteors.length > 0 || I.rockets.length > 0 || I.events.size > 0 || !!(I.far && I.far.quick);
  // with the Map hidden only the sky goes on: the map's own motion waits for it to show again
  if (sky || !I.mapOn) return sky;
  return I.quick || I.alpha > 0.01 || I.comets.length > 0 || I.cometQ.length > 0 || I.ghosts.length > 0 ||
    I.bursts.length > 0 || !!I.glide || !!I.drag || !!I.band || !!I.keep || !!(I.trail && I.trail.size) || performance.now() < (I.regrid || 0);
}
// the screen's refresh interval: the median of the last back-to-back frames
function paceSample(P, d) {
  P.d.push(d);
  if (P.d.length > 15) P.d.shift();
  if (P.d.length >= 5) { const s = P.d.slice().sort((a, b) => a - b); P.ms = s[s.length >> 1]; }
}
// after a frame: the next refresh while something quick goes on (and always under reduced motion, as before),
// else every k-th refresh for the ambient rate (k from the measured refresh, so frames stay even), or a tick at rest
function paceNext(ts, hot) {
  const P = I.pace;
  if (I.still || hot || quickNow()) { P.at = 0; later(0); return; }
  const fps = (I.lively ? PACE_LIVELY_FPS : PACE_FPS) / (away.battery ? 2 : 1);
  P.fps = resting() ? 1000 / REST_TICK_MS : fps;
  P.at = ts + (resting() ? REST_TICK_MS : P.ms * Math.max(1, Math.round(1000 / (fps * P.ms))));
  later(P.at);
}
// sleep until just before the refresh at `at` (a timer, then a frame callback); one coming sooner skips on
function later(at) {
  const P = I.pace, wait = at - performance.now() - P.ms * 0.6;
  clearTimeout(P.timer); P.timer = 0;
  if (wait < 1) { P.chain = true; I.raf = requestAnimationFrame(frame); return; }
  P.chain = false; I.raf = 0;
  P.timer = setTimeout(() => { P.timer = 0; if (I.running && !I.raf) I.raf = requestAnimationFrame(frame); }, wait);
}

// ---------- graph ----------
// a repo hub's id: its root, the same for "Z:/x/" and "z:\x"
const repoId = (root) => 'r:' + String(root).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
function visibleSessions(state) {
  const set = state.settings || {};
  // the shell (app.js) has already applied the repo menu and the / filter, with its own rules (a repo
  // picked by folder name, a query that matches the branch); filtering again here would drop sessions
  // new sessions the desktop window started (no log yet) come from the shell as state.pending
  // the "recently finished" strip's conversations (state.finishedSessions, from the shell) show too, as small
  // dim nodes on their repo; other finished conversations stay off the map unless showDone
  if (Array.isArray(state.allSessions)) {
    // a handing-off stand-in whose pickup runs here comes keyed by that pickup's id (the node was re-keyed to it)
    const out = (state.sessions || []).filter((s) => s.state !== 'DONE' || !!((I.ui && I.ui.showDone) || set.showDone));
    const ids = new Set(out.map((s) => s.id));
    for (const s of state.finishedSessions || []) if (s && !ids.has(s.id)) { ids.add(s.id); out.push(s); }
    return out.concat(state.pending || []);
  }
  const q = String((I.ui && I.ui.query != null ? I.ui.query : set.query) || '').trim();
  const repo = (I.ui && I.ui.repo !== undefined ? I.ui.repo : set.repo) || null;
  const showDone = !!((I.ui && I.ui.showDone) || set.showDone);
  let re = null;
  if (q) { try { re = new RegExp(q, 'i'); } catch { re = null; } }
  const ql = q.toLowerCase();
  return (state.sessions || []).filter((s) => {
    if (s.state === 'DONE' && !showDone) return false;
    if (repo && (!s.repo || String(s.repo.root).toLowerCase() !== String(repo).toLowerCase())) return false;
    if (!q) return true;
    const hay = [s.name, s.goal, s.repo && s.repo.name].filter(Boolean).join('\n');
    return re ? re.test(hay) : hay.toLowerCase().includes(ql);
  });
}

function rebuild() {
  const state = I.state, nowC = Date.now() - I.skew;
  const list = visibleSessions(state);
  const finIds = Array.isArray(state.finishedSessions) ? new Set(state.finishedSessions.map((s) => s && s.id)) : null;
  const visible = new Set(list.map((s) => s.id));
  const nodes = [], byId = new Map(), springs = [], paths = [];
  const add = (n) => { const had = byId.get(n.id); if (had) return had; n.h = hashNum(n.id); byId.set(n.id, n); nodes.push(n); return n; };

  // clashes between conversations that are both on the map
  const clashes = [];
  const clashKeys = new Map();
  for (const c of state.clashes || []) {
    const ss = (c.sessions || []).filter((x) => visible.has(x.id));
    if (ss.length < 2) continue;
    const cc = { ...c, sessions: ss, id: 'f:' + c.key };
    clashes.push(cc);
    clashKeys.set(c.key, cc);
  }
  // conflicts (state.conflicts) between conversations that are both on the map: a branch, a worktree, a migration
  const conflicts = [];
  for (const c of Array.isArray(state.conflicts) ? state.conflicts : []) {
    if (!c || typeof c.id !== 'string') continue;
    const ss = (c.sessions || []).filter((id) => visible.has(id));
    if (ss.length < 2) continue;
    conflicts.push({ ...c, sessions: ss });
  }

  for (const s of list) {
    const sn = add({ id: 's:' + s.id, kind: 'session', s, sid: s.id, agents: [], fin: !!(finIds && finIds.has(s.id) && s.state === 'DONE') });
    if (s.repo && s.repo.root) {
      const rid = repoId(s.repo.root);
      const rn = add({ id: rid, kind: 'repo', name: s.repo.name || s.repo.root, root: s.repo.root, color: s.repo.color || COL.dim, sessions: [], members: [] });
      rn.sessions.push(s);
      springs.push({ a: sn.id, b: rid, rest: REST.repo, repo: rn });
      sn.cl = rid;
    } else sn.cl = '_none';
    if (sn.fin) continue; // a finished conversation: only its link to the repo (steady, nothing around it)
    // agents orbit their conversation on fixed slots, so they are placed, not simulated
    const ags = (s.agents || []).slice(-MAX_AGENTS);
    ags.forEach((a, i) => {
      const an = add({ id: `a:${s.id}:${a.id}`, kind: 'agent', a, s, sid: s.id, parent: sn.id, idx: i, count: ags.length });
      sn.agents.push(an);
    });
    if (s.ship && s.ship.pr) {
      const pid = `p:${s.ship.repo || ''}#${s.ship.pr}`;
      const pn = add({ id: pid, kind: 'pr', s, sid: s.id, num: s.ship.pr, ship: s.ship, cl: sn.cl });
      springs.push({ a: sn.id, b: pn.id, rest: REST.pr });
    }
    // files: the shared ones (clashes) stay; the rest show while touched in the last ten minutes
    const files = (s.files || []).slice().sort((a, b) => b.t - a.t);
    let recentCount = 0;
    for (const f of files) {
      const age = nowC - f.t;
      const cc = clashKeys.get(f.key);
      // a clash that leaves this one out (a fork's copy of its parent's history touched it): no line to it
      if (cc && !cc.sessions.some((x) => x.id === s.id)) continue;
      if (!cc) {
        if (age >= FADE_MS || recentCount >= MAX_RECENT) continue;
        recentCount++;
        const fid = 'f:' + f.key;
        const fn = add({ id: fid, kind: 'recent', f, s, sid: null, cl: sn.cl, lastT: f.t });
        fn.lastT = Math.max(fn.lastT, f.t);
        springs.push({ a: sn.id, b: fid, rest: REST.recent });
        paths.push({ a: sn.id, b: fid, t: f.t, wrote: f.wrote, hue: s.hue });
      } else if (age < FADE_MS) {
        paths.push({ a: sn.id, b: cc.id, t: f.t, wrote: f.wrote, hue: s.hue });
      }
    }
  }
  // the listed repos with no conversation on the map: their hub alone (its territory around it)
  for (const r of state.repoAnchors || []) {
    if (!r || !r.root) continue;
    add({ id: repoId(r.root), kind: 'repo', name: r.name || r.root, root: r.root, color: r.color || COL.dim, sessions: [], members: [] });
  }
  // a repo's territory is drawn around its conversations and their PRs
  for (const n of nodes) if ((n.kind === 'session' || n.kind === 'pr') && n.cl !== '_none') { const r = byId.get(n.cl); if (r && r.members) r.members.push(n); }
  // a repo with more conversations holds them on a wider ring, so their labels have room
  for (const e of springs) if (e.repo) e.rest = ringR(e.repo);
  for (const cc of clashes) {
    const first = byId.get('s:' + cc.sessions[0].id);
    add({ id: cc.id, kind: 'clash', c: cc, sid: null, cl: first ? first.cl : '_none' });
    for (const x of cc.sessions) springs.push({ a: 's:' + x.id, b: cc.id, rest: REST.clash });
  }
  for (const k of conflicts) {
    const first = byId.get('s:' + k.sessions[0]);
    add({ id: k.id, kind: 'conflict', k, sid: null, cl: first ? first.cl : '_none' });
    for (const id of k.sessions) springs.push({ a: 's:' + id, b: k.id, rest: REST.conflict, conflict: true });
  }
  // worktrees on their repo's hub (state.worktrees, the main checkout left out by the server)
  for (const w of Array.isArray(state.worktrees) ? state.worktrees : []) {
    const r = w && w.root && byId.get(repoId(w.root));
    if (r && r.kind === 'repo') (r.wts || (r.wts = [])).push(w);
  }
  for (const n of nodes) if (n.kind === 'repo' && n.wts) {
    n.wts.sort((a, b) => (a.name < b.name ? -1 : 1));
    n.wtsLive = n.wts.filter((w) => w.live); // only these are drawn
  }
  // teams: pairs of members that are both on the map (all pairs up to 4 members, a ring around them beyond)
  const teams = [];
  for (const t of Array.isArray(state.teams) ? state.teams : []) {
    if (!t || !t.id || !Array.isArray(t.members)) continue;
    const ms = t.members.filter((id) => byId.has('s:' + id));
    if (ms.length < 2) continue;
    // its lead (★), when it leads and is on the map: the links become spokes from it
    teams.push({ t, members: ms, pairs: [], lead: t.lead && ms.includes(t.lead) ? t.lead : null });
  }
  // levels (teams nest): a team's lead may be a plain member of a team above (up), led by another lead; that team's
  // spoke to it is drawn stronger, and its ★ badge carries a ring in the colour above
  for (const tm of teams) tm.up = tm.lead ? teams.find((u) => u !== tm && u.lead !== tm.lead && u.members.includes(tm.lead)) || null : null;
  // parity partners (one line per pair, from the web side to the app side) and one-sided changes
  const parity = [], seenPair = new Set();
  for (const s of list) {
    const p = s.parity;
    if (!p || byId.get('s:' + s.id).fin) continue;
    if (p.partner && byId.has('s:' + p.partner)) {
      const key = s.id < p.partner ? s.id + '|' + p.partner : p.partner + '|' + s.id;
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      const o = byId.get('s:' + p.partner).s;
      // the web side first: the one that wrote web files, or that didn't write app files
      const webFirst = (s.side && s.side.web) || !(s.side && s.side.app) || (o.side && o.side.app);
      parity.push(webFirst ? { a: 's:' + s.id, b: 's:' + p.partner } : { a: 's:' + p.partner, b: 's:' + s.id });
    }
  }
  // handoff trails: from the conversation it was picked up from, when that one is on the map too
  const trails = [];
  for (const s of list) {
    const f = s.pickedUpFrom && s.pickedUpFrom.id;
    if (f && f !== s.id && byId.has('s:' + f)) trails.push({ a: 's:' + f, b: 's:' + s.id, name: s.pickedUpFrom.name || f });
  }

  // a handoff's pickup that just showed up carries on from the node it took over (state.handoffPairs, old id -> new
  // id): the same spot, look and pick, so it is not born as a new conversation next to its hub while the old one
  // leaves. The old node may have started fading out a moment ago (it left one poll earlier): taken back from there.
  const carried = new Set();
  for (const [from, to] of state.handoffPairs || []) {
    const a = 's:' + from, b = 's:' + to;
    if (byId.has(a) || !byId.has(b) || I.pos.has(b)) continue;
    const gi = I.ghosts.findIndex((g) => g.n.id === a);
    const p = I.pos.get(a) || (gi >= 0 ? I.ghosts[gi].n.p : null);
    if (!p) continue;
    if (gi >= 0) I.ghosts.splice(gi, 1);
    I.pos.set(a, p);
    carryNode(a, b);
    carried.add(a);
  }

  // seed positions for new nodes next to something they link to
  const nb = new Map();
  for (const e of springs) {
    if (!nb.has(e.a)) nb.set(e.a, []);
    if (!nb.has(e.b)) nb.set(e.b, []);
    nb.get(e.a).push(e.b); nb.get(e.b).push(e.a);
  }
  assignHomes(nodes);
  const sim = nodes.filter((n) => n.kind !== 'agent');
  let fresh = 0;
  // repos first, then sessions, then the rest, so each new node can find an anchor that already exists
  const order = { repo: 0, session: 1, pr: 2, clash: 3, conflict: 3, recent: 4 };
  for (const n of sim.slice().sort((a, b) => order[a.kind] - order[b.kind])) {
    let p = I.pos.get(n.id);
    if (!p) {
      const anchor = (nb.get(n.id) || []).map((id) => I.pos.get(id)).find(Boolean);
      const home = I.homeXY.get(n.kind === 'repo' ? n.id : n.cl) || { x: 0, y: 0 };
      const base = anchor || home;
      const hubN = n.kind === 'session' && byId.get(n.cl);
      const r = anchor ? (n.kind === 'session' ? (hubN && hubN.sessions ? ringR(hubN) : REST.repo) : n.kind === 'pr' ? REST.pr : REST.recent) : n.kind === 'repo' ? 0 : 60;
      let a = hashNum(n.id) * Math.PI * 2;
      // a new conversation takes the widest free gap around its repo, so the ring fills evenly
      if (n.kind === 'session' && anchor) {
        const taken = [];
        for (const m of sim) { const mp = I.pos.get(m.id); if (m !== n && m.kind === 'session' && m.cl === n.cl && mp) taken.push(Math.atan2(mp.y - anchor.y, mp.x - anchor.x)); }
        if (taken.length) {
          taken.sort((x, y) => x - y);
          let best = 0, gapBest = -1;
          taken.forEach((t, i) => {
            const nx = i + 1 < taken.length ? taken[i + 1] : taken[0] + Math.PI * 2;
            if (nx - t > gapBest) { gapBest = nx - t; best = t + (nx - t) / 2; }
          });
          a = best;
        }
      }
      p = { x: base.x + Math.cos(a) * r, y: base.y + Math.sin(a) * r, vx: 0, vy: 0 };
      const h = n.kind === 'session' && I.homeXY.get(n.id), hub = h && I.pos.get(n.cl);
      if (hub) { p.x = hub.x + h.x; p.y = hub.y + h.y; } // a conversation dragged before: back where it was
      I.pos.set(n.id, p);
      fresh++;
    }
    n.p = p;
    // drift: two slow waves per axis, periods 6-10 s, phases fixed per node id (a draw offset only)
    const w = (sfx) => TAU / (6000 + 4000 * hashNum(n.id + sfx));
    n.dr = n.fin ? null : [w('x1'), hashNum(n.id + 'px') * TAU, w('x2') * 0.62, hashNum(n.id + 'qx') * TAU,
      w('y1'), hashNum(n.id + 'py') * TAU, w('y2') * 0.62, hashNum(n.id + 'qy') * TAU];
  }
  // conversations that left: fade out where they were (only when the map was on screen just now)
  const tNow = performance.now();
  if (I.byId && I.lastDraw && tNow - I.lastDraw < 1500) {
    for (const old of I.nodes) {
      if (old.kind !== 'session' || byId.has(old.id) || old.sx === undefined || carried.has(old.id)) continue;
      // handed off: it flies into its pickup's node instead of fading where it was
      const to = state.handoffPairs && state.handoffPairs.get(old.sid);
      if (!I.ghosts.some((g) => g.n.id === old.id)) I.ghosts.push({ n: old, at: tNow, to: to && byId.has('s:' + to) ? 's:' + to : null });
    }
  }
  I.ghosts = I.ghosts.filter((g) => !byId.has(g.n.id) && tNow - g.at < (g.to ? HANDOFF_GHOST_MS : GHOST_MS));
  for (const id of [...I.pos.keys()]) if (!byId.has(id)) I.pos.delete(id);
  for (const id of [...I.ang.keys()]) if (!byId.has(id)) I.ang.delete(id);
  for (const id of [...I.orb.keys()]) if (!byId.has(id)) I.orb.delete(id);
  for (const id of [...I.aura.keys()]) if (!byId.has(id)) I.aura.delete(id);
  for (const id of [...I.agl.keys()]) if (!byId.has(id)) I.agl.delete(id);
  for (const id of [...I.hub.keys()]) if (!byId.has(id)) I.hub.delete(id);
  for (const id of [...I.look.keys()]) if (!byId.has(id) && !I.ghosts.some((g) => g.n.id === id)) I.look.delete(id);

  // the running agents of the conversations shown (not the finished ones), for the satellites, keyed as their nodes are
  I.satRun = [];
  for (const n of nodes) if (n.kind === 'agent' && n.a.state === 'run') I.satRun.push(n.id);
  I.nodes = nodes; I.byId = byId; I.springs = springs; I.paths = paths; I.clashes = clashes; I.sim = sim;
  I.conflicts = conflicts; I.teams = teams; I.parity = parity; I.trails = trails;
  if (sim.length && !I.camUntil) I.camUntil = performance.now() + 2000;
  const sig = sim.map((n) => n.id).sort().join('\n');
  if (sig !== I.sig) {
    I.sig = sig;
    I.lab.clear();
    I.alpha = Math.max(I.alpha, I.settledOnce ? 0.35 : 1);
    // first look (or a big change): settle before showing, so the map opens calm instead of exploding
    if (!I.settledOnce || fresh > 6) { for (let i = 0; i < 260; i++) simStep(); I.settledOnce = true; }
  }
  if (I.sel && !byId.has(I.sel)) I.sel = null;
  if (I.hover && !byId.has(I.hover)) I.hover = null;
  I.emptyEl.style.display = nodes.length ? 'none' : 'flex';
  if (!nodes.length) {
    I.emptyEl.textContent = '';
    const a = document.createElement('div'); a.textContent = 'No live conversations';
    a.style.color = COL.dim; I.emptyEl.appendChild(a);
    if (state.hiddenDone) {
      const b = document.createElement('div'); b.style.color = COL.faint; b.style.fontSize = '12px';
      b.textContent = `${state.hiddenDone} finished ${state.hiddenDone === 1 ? 'conversation' : 'conversations'} hidden`;
      I.emptyEl.appendChild(b);
    }
  }
  I.dirty = true;
}

// ---------- signals: each new tool call travels along an edge as a comet ----------
// The shell rebases timestamps on every poll (a few ms of jitter), so an entry is "seen" when the same
// sid/who/verb/what was seen within 1.5 s of its t. Everything in the first state the map sees is history.
function ingestFeed(state) {
  const feed = state.feed || [];
  const nowC = Date.now() - I.skew, nowP = performance.now(); // in replay, nowC is state.now (the replay's clock)
  // replay scrubbed back: what was seen is ahead of the clock now, so it may travel again
  if (I.replay) { if (I.replayT !== null && state.now < I.replayT) I.seen.clear(); I.replayT = state.now; }
  const first = !I.feedInit;
  I.feedInit = true;
  for (const e of feed) {
    if (!e || typeof e.t !== 'number') continue;
    const key = e.sid + '\u0001' + e.who + '\u0001' + e.verb + '\u0001' + e.what;
    let ts = I.seen.get(key);
    if (ts && ts.some((t) => Math.abs(t - e.t) < 1500)) continue;
    if (!ts) I.seen.set(key, (ts = []));
    ts.push(e.t);
    if (first || nowC - e.t > COMET_MAX_AGE) continue;
    const ends = cometEnds(e);
    if (!ends) continue;
    const at = Math.max(nowP, I.nextLaunch);
    if (at - nowP > 2000) continue; // a backlog that big is history by the time it would launch
    I.nextLaunch = at + COMET_STAGGER;
    I.cometQ.push({ a: ends[0], b: ends[1], at, hue: ends[2] });
  }
  // forget entries that dropped out of the feed long ago
  if (I.seen.size > 400) {
    for (const [k, ts] of I.seen) if (ts[ts.length - 1] < nowC - 15 * 60e3) I.seen.delete(k);
  }
}

const baseName = (rel) => { const p = String(rel || '').replace(/\\/g, '/').split('/'); return (p[p.length - 1] || '').toLowerCase(); };

// [from id, to id, hue] for a feed entry, or null when its conversation isn't on the map
function cometEnds(e) {
  const sn = I.byId.get('s:' + e.sid);
  if (!sn) return null;
  const hue = sn.s.hue || COL.cyan;
  // a message to another conversation (a teammate): from one to the other, along their team's link
  if (e.to) {
    const tn = I.byId.get('s:' + e.to);
    if (!tn) return null;
    const team = I.teams.find((t) => t.members.includes(e.sid) && t.members.includes(e.to));
    return [sn.id, tn.id, (team && team.t.color) || hue];
  }
  if (e.who && e.who !== 'main') {
    const ag = sn.agents.find((n) => n.a.label === e.who && n.a.state === 'run') || sn.agents.find((n) => n.a.label === e.who);
    if (ag) return [ag.id, sn.id, hue];
  } else if (e.what) {
    const w = String(e.what).toLowerCase();
    for (const p of I.paths) {
      if (p.a !== sn.id) continue;
      const b = I.byId.get(p.b);
      if (!b) continue;
      const base = baseName(b.kind === 'recent' ? b.f.rel : b.c && b.c.rel);
      if (base && (w === base || (base.length >= 4 && w.includes(base)))) return [sn.id, b.id, hue];
    }
  }
  if ((e.verb === 'shell' || e.verb === 'pwsh') && PUSH_RE.test(String(e.what || ''))) {
    const pr = I.nodes.find((n) => n.kind === 'pr' && n.sid === e.sid);
    if (pr) return [sn.id, pr.id, hue];
  }
  if (sn.cl && sn.cl !== '_none' && I.byId.has(sn.cl)) return [sn.id, sn.cl, hue];
  return null;
}

// A team's new order (its `at` moved on): one comet from the team's pill to each member. A team seen for the first
// time is history, unless its order is younger than COMET_MAX_AGE (it was just made).
function ingestTeams(state) {
  const nowC = Date.now() - I.skew, first = !I.teamInit;
  I.teamInit = true;
  for (const t of Array.isArray(state.teams) ? state.teams : []) {
    if (!t || !t.id) continue;
    const prev = I.teamAt.get(t.id);
    I.teamAt.set(t.id, t.at);
    if (first || !Number.isFinite(t.at) || (prev !== undefined && !(t.at > prev))) continue;
    if (prev === undefined && nowC - t.at > COMET_MAX_AGE) continue;
    const tm = I.teams.find((x) => x.t.id === t.id);
    if (!tm) continue;
    let at = Math.max(performance.now() + 120, I.nextLaunch); // after the pill has been placed once
    for (const id of tm.members) {
      I.cometQ.push({ a: 'T:' + t.id, b: 's:' + id, at, hue: t.color || COL.cyan });
      at += COMET_STAGGER;
    }
    I.nextLaunch = at;
  }
  if (I.teamAt.size > 200) for (const id of [...I.teamAt.keys()]) if (!(state.teams || []).some((t) => t && t.id === id)) I.teamAt.delete(id);
}

// A merge launch (see "Merge launch" at the top) for each new 'merged' alert (state.alerts, whose n only grows).
// The alert, not a ship's 'merged' step going 'ok', is the signal: the server raises it only for a PR it saw open
// before, while the step also turns 'ok' the first time it looks up an old PR (after a restart, every merged PR at
// once). Everything in the first state the map sees is history, an alert older than MERGE_MAX_AGE too (the map
// was hidden); replay launches nothing, and the first live state after it is history again.
// sky: the Map is hidden, so a new merge sets off a meteor shower anywhere along the top instead (one at most)
function ingestMerges(state, sky) {
  if (I.replay) { I.mergeInit = false; return; }
  const first = !I.mergeInit, nowC = Date.now() - I.skew;
  I.mergeInit = true;
  let top = first ? -Infinity : I.mergeN, at = performance.now();
  for (const a of Array.isArray(state.alerts) ? state.alerts : []) {
    if (!a || !Number.isFinite(a.n)) continue;
    if (!first && a.n > I.mergeN && a.kind === 'merged' && a.sid && !(nowC - a.t > MERGE_MAX_AGE)) {
      if (sky) { if (!I.still) shower(at, null); }
      else if (launchMerge(a.sid, at)) at += MERGE_STAGGER;
    }
    if (a.n > top) top = a.n;
  }
  I.mergeN = top;
}

// deploys going live send up a rocket under their repo's hub: one seen building that is live now, or one first seen
// already live that went live in the last ROCKET_RECENT (server clock); on the page's first state (and after a
// replay) whatever is live is history. Each deploy goes up once (I.dpSeen, the newest ROCKET_SEEN remembered)
function ingestDeploys(state, sky) {
  if (I.replay) { I.dpInit = false; return; }
  const first = !I.dpInit, seen = I.dpSeen, nowC = Date.now() - I.skew;
  I.dpInit = true;
  for (const d of Array.isArray(state.deploys) ? state.deploys : []) {
    if (!d || d.id == null) continue;
    const key = String(d.id), was = seen.get(key);
    seen.delete(key); seen.set(key, d.state); // newest last, so the oldest go first
    if (first || d.state !== 'live' || was === 'live') continue;
    if (was === 'building' || (was === undefined && Number.isFinite(d.readyAt) && nowC - d.readyAt < ROCKET_RECENT)) {
      rocketLaunch(performance.now(), d.root && !sky ? I.byId.get(repoId(d.root)) : null); // the Map hidden: anywhere along the bottom
    }
  }
  while (seen.size > ROCKET_SEEN) seen.delete(seen.keys().next().value);
}

// a conversation's merge: its big comet to its repo's hub (queued in time order), or, when it isn't on the map,
// the hub's landing alone; false when neither is on the map
function launchMerge(sid, at) {
  const sn = I.byId.get('s:' + sid);
  let hub = sn && sn.cl && sn.cl !== '_none' ? I.byId.get(sn.cl) : null;
  if (!hub) {
    const st = I.state || {};
    const s = [...(st.allSessions || []), ...(st.sessions || []), ...(st.finishedSessions || [])].find((x) => x && x.id === sid);
    hub = s && s.repo && s.repo.root ? I.byId.get(repoId(s.repo.root)) : null;
  }
  if (!hub || hub.kind !== 'repo') return false;
  if (sn) {
    const q = I.cometQ, i = q.findIndex((c) => c.at > at);
    q.splice(i < 0 ? q.length : i, 0, { a: sn.id, b: hub.id, at, hue: sn.s.hue || COL.cyan, big: true });
  } else landed(hub, at);
  I.dirty = true;
  return true;
}

// the saved spots: settings.mapSpots [{ id, x, y, pin }]
function loadSpots(state) {
  const m = new Map(), list = state && state.settings && state.settings.mapSpots;
  if (Array.isArray(list)) for (const s of list) {
    if (s && typeof s.id === 'string' && Number.isFinite(s.x) && Number.isFinite(s.y)) m.set(s.id, { x: s.x, y: s.y, pin: !!s.pin });
  }
  return m;
}
// save the spots in a moment (pinned ones first, at most 300). A save already waiting stays, so the small
// nudges of the spacing rule can't keep putting it off; force (a drop, a re-arrange) saves sooner.
// A nudge's save waits for the next /state (renderMap sends it right after syncSpots, or after 5 s if no new
// state comes), so it carries what another screen just moved instead of overwriting it with what was here before.
function saveSpotsSoon(ms = 1500, force = false) {
  if (I.replay) return; // replay: its spots are forgotten when it ends
  if (I.spotsTimer && !force) return;
  clearTimeout(I.spotsTimer);
  I.spotsTimer = setTimeout(() => {
    if (!I) return;
    I.spotsTimer = 0;
    if (force) sendSpots(); else I.spotsDue = I.spotsDue || Date.now();
  }, ms);
}
// Only what this screen changed goes (settings.mapSpotsOps: { op: 'add', id, x, y, pin } and { op: 'remove', id },
// against the server's list as last applied here, spotsSeen), never the whole list: a whole list from a screen that
// has not had the newest /state yet would put back what another screen (or the other machine) just moved or unpinned
function sendSpots() {
  I.spotsDue = 0;
  if (I.replay) return;
  const list = [...I.homeXY].map(([id, h]) => ({ id, x: Math.round(h.x), y: Math.round(h.y), pin: !!h.pin }))
    .sort((a, b) => rank(a) - rank(b)).slice(0, 300);
  const seen = I.spotsSeen, ops = [], have = new Set();
  for (const s of list) {
    have.add(s.id);
    const p = seen.get(s.id);
    if (!p || Math.round(p.x) !== s.x || Math.round(p.y) !== s.y || !!p.pin !== s.pin) ops.push({ op: 'add', ...s });
  }
  for (const id of seen.keys()) if (!have.has(id)) ops.push({ op: 'remove', id });
  // nothing the server doesn't have already: not sent, so a screen whose spots only wobbled sends nothing
  if (!ops.length) return;
  // the server has these once they land: spotsSeen takes them now, and spotsSent keeps them a while, so a /state
  // from before they landed never snaps a later move here back (syncSpots)
  const t = Date.now();
  for (const o of ops) {
    if (o.op === 'add') seen.set(o.id, { x: o.x, y: o.y, pin: o.pin }); else seen.delete(o.id);
    I.spotsSent.push({ ...o, t });
  }
  I.spotsSent = I.spotsSent.filter((o) => t - o.t < SPOT_ECHO_MS).slice(-600);
  try { I.ui.saveSettings && I.ui.saveSettings({ mapSpotsOps: ops }); } catch { /* shell gone */ }
}
const SPOT_ECHO_MS = 15e3;
// this screen's own op on a spot, sent in the last SPOT_ECHO_MS, that a /state does not show yet (null: none)
function spotInFlight(id, h) {
  const t = Date.now();
  for (let i = I.spotsSent.length - 1; i >= 0; i--) {
    const o = I.spotsSent[i];
    if (o.id !== id || t - o.t >= SPOT_ECHO_MS) continue;
    const landed = o.op === 'add' ? !!h && h.x === o.x && h.y === o.y && !!h.pin === o.pin : !h;
    return landed ? null : o;
  }
  return null;
}
const spotsSig = (list) => JSON.stringify(Array.isArray(list) ? list : []);
// Spots another screen changed: each /state carries the server's list, and when it differs from the one last
// seen, only what changed between the two is applied here (a spot moved, added or dropped there). So the
// spots this screen moved and hasn't saved yet stay as they are, and a save waiting here then carries both.
// Not taken: the echo of one of this screen's own saves (else an older save coming back would snap a later move
// back), the repo or conversation being dragged here right now (the drop decides), and anything during a replay
// (its spots are its own; the change is taken once it ends). A moved repo's whole group goes there at once, as
// it is: gliding it there would drag it through the groups in between, and the spacing rule would then push
// those aside on this screen only, and save that, and the other screen would push back (two screens tried it:
// the repos spread out across the map).
function syncSpots(set) {
  if (!('mapSpots' in set) || I.replay) return;
  const sig = spotsSig(set.mapSpots);
  if (sig === I.spotsSig) return;
  const next = loadSpots({ settings: { mapSpots: set.mapSpots } }), prev = I.spotsSeen;
  I.spotsSig = sig; I.spotsSeen = next;
  const d = I.drag && I.drag.moved ? I.drag : null;
  const held = new Set(d ? [d.node, ...(d.hubs || [])].filter(Boolean) : []);
  const same = (a, b) => a && b && a.x === b.x && a.y === b.y && a.pin === b.pin;
  const moved = new Map(); // repo id -> how far its spot moved here
  let convs = false;
  for (const [id, h] of next) {
    // the echo of this screen's own op, or a /state from before it landed: this screen's spot stands
    if (same(prev.get(id), h) || held.has(id) || spotInFlight(id, h)) continue;
    const cur = I.homeXY.get(id);
    if (same(cur && { x: Math.round(cur.x), y: Math.round(cur.y), pin: !!cur.pin }, h)) continue;
    I.homeXY.set(id, { x: h.x, y: h.y, pin: h.pin });
    if (id.startsWith('s:')) convs = true; else if (cur) moved.set(id, { dx: h.x - cur.x, dy: h.y - cur.y });
  }
  // a conversation unpinned there (its offset dropped) goes back on its repo's ring here too. A repo spot is never
  // dropped this way (a re-arrange there sends the new ones), but one pinned before and gone from the list now was
  // unpinned elsewhere: it is let go here too, where it is (else this screen would send it back pinned and undo the
  // unpin on every screen)
  for (const id of prev.keys()) {
    if (next.has(id) || held.has(id) || !I.homeXY.has(id) || spotInFlight(id, null)) continue;
    if (id.startsWith('s:')) { I.homeXY.delete(id); convs = true; continue; }
    const cur = I.homeXY.get(id);
    if (prev.get(id).pin && cur.pin) { I.homeXY.set(id, { ...cur, pin: false }); convs = true; }
  }
  if (!moved.size && !convs) return;
  if (moved.size) {
    for (const n of I.sim || []) {
      const m = n.p && moved.get(n.kind === 'repo' ? n.id : n.cl);
      if (m) { n.p.x += m.dx; n.p.y += m.dy; n.p.vx = n.p.vy = 0; }
    }
    for (const [id] of moved) {
      if (I.trail) I.trail.delete(id);
    }
  }
  if (convs) I.alpha = Math.max(I.alpha, 0.05);
  I.dirty = true;
}
// kept first when there are too many: pinned repos, other repo spots, then pinned conversations
const rank = (x) => (x.id.startsWith('s:') ? 2 : x.pin ? 0 : 1);
const pinned = (id) => { const h = I.homeXY.get(id); return !!(h && h.pin); };
// a dragged conversation's place: its saved offset from its repo's hub (or its group's spot when it has no repo)
function convBase(n) {
  const hub = I.byId && I.byId.get(n.cl);
  return hub && hub.p ? hub.p : I.homeXY.get(n.cl) || null;
}
function convPin(n) {
  const h = n.kind === 'session' && I.homeXY.get(n.id), b = h && convBase(n);
  return b ? { x: b.x + h.x, y: b.y + h.y } : null;
}
// the repo whose group a dragged conversation is over, when it isn't its own: the nearest hub whose group
// reaches the point (null over its own group or empty space)
function dropRepo(n) {
  if (!n.p || !n.s || n.s.pending || n.s.demo || typeof (I.ui && I.ui.moveSession) !== 'function') return null;
  const ext = groupExt(I.sim);
  let best = null, bd = Infinity;
  for (const r of I.sim) {
    if (r.kind !== 'repo' || !r.p) continue;
    const d = Math.hypot(n.p.x - r.p.x, n.p.y - r.p.y);
    if (d <= Math.max(70, (ext.get(r.id) || 40) * 0.9) && d < bd) { bd = d; best = r; }
  }
  return best && best.id !== n.cl ? best : null;
}

// Each cluster (a repo and its conversations) gets a spot it keeps (see "Repo spots" at the top).
function assignHomes(nodes) {
  const ids = [];
  for (const n of nodes) if (n.kind === 'repo') ids.push(n.id);
  if (nodes.some((n) => n.kind === 'session' && n.cl === '_none')) ids.push('_none');
  for (const id of ids) if (!I.homeOrder.includes(id)) I.homeOrder.push(id);
  const live = I.homeOrder.filter((id) => ids.includes(id));
  // repos that already have a spot keep it: only new ones are placed
  const missing = live.filter((id) => !I.homeXY.has(id));
  if (!missing.length) return;
  const size = new Map();
  for (const n of nodes) { const c = n.kind === 'repo' ? n.id : n.cl; size.set(c, (size.get(c) || 0) + 1); }
  // clusters are packed in rows, each as wide as its size needs, rows centred; the target row width
  // follows the canvas shape so several repos use the width instead of piling up in the middle
  const aspect = I.W && I.H ? I.W / I.H : 1.6;
  // at least the room separate() keeps around the group as it is now, so homes and spacing never pull apart
  const ext = groupExt(nodes);
  const radius = (id) => Math.max(70 + 30 * Math.sqrt(Math.ceil((size.get(id) || 1) / 4) * 4), ((ext.get(id) || 0) + CLUSTER_PAD) / 1.15);
  const placed = live.filter((id) => I.homeXY.has(id));
  if (placed.length) {
    // the nearest free spot to the middle of the others, clear of each of them (stretched to the window's shape)
    const s = Math.sqrt(clamp(aspect, 0.5, 3));
    for (const id of missing) {
      const others = live.filter((o) => o !== id && I.homeXY.has(o)).map((o) => [o, I.homeXY.get(o)]);
      const cx = others.reduce((t, [, h]) => t + h.x, 0) / others.length, cy = others.reduce((t, [, h]) => t + h.y, 0) / others.length;
      const free = (x, y) => others.every(([o, h]) => Math.hypot(x - h.x, y - h.y) >= (radius(id) + radius(o)) * 1.15 + CLUSTER_GAP);
      let spot = null;
      for (let ring = 1; ring < 120 && !spot; ring++) {
        const r = ring * 40, steps = Math.max(6, Math.round((TAU * r) / 40));
        for (let k = 0; k < steps && !spot; k++) {
          const a = (k / steps) * TAU, x = cx + Math.cos(a) * r * s, y = cy + Math.sin(a) * r / s;
          if (free(x, y)) spot = { x, y, pin: false };
        }
      }
      I.homeXY.set(id, spot || { x: cx, y: cy, pin: false });
    }
    saveSpotsSoon();
    return;
  }
  // the first layout: try every row width that changes the packing and keep the one that lets the camera zoom in most
  const pack = (rowW) => {
    const rows = [];
    let row = null;
    for (const id of live) {
      const w = 2 * radius(id) * 1.3 + CLUSTER_GAP;
      if (!row || (row.w + w > rowW + 0.5 && row.ids.length)) rows.push((row = { ids: [], ws: [], w: 0, h: 0 }));
      row.ids.push(id); row.ws.push(w); row.w += w; row.h = Math.max(row.h, 2 * radius(id) * 1.15 + CLUSTER_GAP);
    }
    return rows;
  };
  let rows = pack(Infinity), bestScore = -1;
  const widths = new Set([Infinity]);
  for (let i = 0; i < live.length; i++) { let w = 0; for (let j = i; j < live.length; j++) { w += 2 * radius(live[j]) * 1.3 + CLUSTER_GAP; widths.add(w); } }
  for (const rw of widths) {
    const r = pack(rw);
    const tw = Math.max(...r.map((x) => x.w)), th = r.reduce((t, x) => t + x.h, 0);
    // the current packing wins near-ties, so repos don't swap rows back and forth as their sizes wobble
    const same = r.map((x) => x.ids.join(',')).join('/') === I.homeSig;
    const score = Math.min(aspect / tw, 1 / th) * (same ? 1.05 : 1);
    if (score > bestScore * 1.02) { bestScore = score; rows = r; }
  }
  const totalH = rows.reduce((t, r) => t + r.h, 0);
  I.homeSig = rows.map((r) => r.ids.join(',')).join('/');
  let y = -totalH / 2;
  for (const r of rows) {
    let x = -r.w / 2;
    r.ids.forEach((id, i) => { I.homeXY.set(id, { x: x + r.ws[i] / 2, y: y + r.h / 2, pin: false }); x += r.ws[i]; });
    y += r.h;
  }
  saveSpotsSoon();
}

// re-arrange: the repos that aren't pinned (all of them with unpin) get new spots around the pinned ones
function rearrange(unpin) {
  for (const [id, h] of [...I.homeXY]) if (unpin || !h.pin) I.homeXY.delete(id);
  assignHomes(I.nodes);
  I.alpha = Math.max(I.alpha, 0.3);
  I.dirty = true;
  // the groups glide across the map to their new spots, through each other: for the next 8 s the spacing rule
  // leaves whole groups alone (separate), and the camera drops the hand's pan and zoom (as 0 does; else the fit
  // landed beside the new layout) and keeps fitting them
  I.regrid = performance.now() + 8000;
  recenter(8000);
  saveSpotsSoon(300, true);
}

// A dragged repo's members (conversations, PRs, files) ease toward their place around the hub each frame instead
// of moving with it as one rigid block: conversations keep up closely, the dots around them lag a little more,
// the far ones a little more again. No overshoot, and it ends on the shape the group had when the drag began.
// I.trail: hub id -> its trail, one for each hub on the move (several when a multi-selection's hubs move together).
// Everything in it is held by id, never by node: each /state rebuilds the nodes (a second or less apart while
// conversations are working), and a trail tied to the old objects fell apart mid-drag, leaving the group behind.
function startTrail(hub) {
  if (!I.trail) I.trail = new Map();
  let tr = I.trail.get(hub.id);
  if (!tr) I.trail.set(hub.id, (tr = { id: hub.id, offs: new Map(), t: performance.now() }));
  // a member that showed up since (a new conversation, a PR) joins where it is now
  for (const m of I.sim) if (m.p && m !== hub && m.cl === hub.id && !tr.offs.has(m.id)) tr.offs.set(m.id, { x: m.p.x - hub.p.x, y: m.p.y - hub.p.y });
}
const trailing = (nd) => { if (I.trail) for (const tr of I.trail.values()) if (nd.cl === tr.id && tr.offs.has(nd.id)) return true; return false; };
function trailStep(now) {
  if (!I.trail || !I.trail.size) return false;
  for (const tr of I.trail.values()) {
    const hub = I.byId.get(tr.id);
    if (!hub || !hub.p) { I.trail.delete(tr.id); continue; }
    const dt = Math.min(64, Math.max(1, now - tr.t)) / 16.7;
    tr.t = now;
    let most = 0;
    for (const [id, o] of tr.offs) {
      const m = I.byId.get(id);
      if (!m || !m.p || m.cl !== tr.id) { tr.offs.delete(id); continue; }
      const tx = hub.p.x + o.x, ty = hub.p.y + o.y, ex = tx - m.p.x, ey = ty - m.p.y;
      const far = Math.min(1, Math.hypot(o.x, o.y) / 500);
      const k = (m.kind === 'session' ? 0.3 : 0.2) * (1 - 0.35 * far);
      const f = 1 - Math.pow(1 - k, dt);
      m.p.x += ex * f; m.p.y += ey * f; m.p.vx = m.p.vy = 0;
      most = Math.max(most, Math.abs(ex), Math.abs(ey));
    }
    if (most < 0.3 && !(I.drag && I.drag.hubs && I.drag.hubs.includes(tr.id))) {
      for (const [id, o] of tr.offs) { const m = I.byId.get(id); if (m && m.p) { m.p.x = hub.p.x + o.x; m.p.y = hub.p.y + o.y; } }
      I.trail.delete(tr.id);
    }
  }
  return true;
}

function simStep() {
  const ns = I.sim, n = ns.length, al = I.alpha;
  if (!n) return;
  for (let i = 0; i < n; i++) {
    const a = ns[i];
    const ca = CHARGE[a.kind] + (a.kind === 'session' ? 7 * a.agents.length - (a.fin ? FIN_CHARGE_CUT : 0) : 0);
    for (let j = i + 1; j < n; j++) {
      const b = ns[j];
      let dx = a.p.x - b.p.x, dy = a.p.y - b.p.y, d2 = dx * dx + dy * dy;
      if (d2 > 700 * 700) continue;
      if (d2 < 1) { const t = hashNum(a.id + b.id) * Math.PI * 2; dx = Math.cos(t); dy = Math.sin(t); d2 = 1; }
      const cb = CHARGE[b.kind] + (b.kind === 'session' ? 7 * b.agents.length - (b.fin ? FIN_CHARGE_CUT : 0) : 0);
      const d = Math.sqrt(d2), f = Math.min(30, (ca * cb) / d2) * al;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.p.vx += fx / MASS[a.kind]; a.p.vy += fy / MASS[a.kind];
      b.p.vx -= fx / MASS[b.kind]; b.p.vy -= fy / MASS[b.kind];
    }
  }
  for (const e of I.springs) {
    const a = I.byId.get(e.a), b = I.byId.get(e.b);
    if (!a || !b || !a.p || !b.p) continue;
    const dx = b.p.x - a.p.x, dy = b.p.y - a.p.y, d = Math.sqrt(dx * dx + dy * dy) || 0.1;
    const f = 0.09 * (d - e.rest) * al;
    const fx = (dx / d) * f, fy = (dy / d) * f;
    a.p.vx += fx / MASS[a.kind]; a.p.vy += fy / MASS[a.kind];
    b.p.vx -= fx / MASS[b.kind]; b.p.vy -= fy / MASS[b.kind];
  }
  for (const nd of ns) {
    if (trailing(nd)) continue; // trailing a dragged repo: trailStep moves it
    const h = I.homeXY.get(nd.kind === 'repo' ? nd.id : nd.cl) || { x: 0, y: 0 };
    if (nd.kind === 'repo' && h.pin) { nd.p.x = h.x; nd.p.y = h.y; nd.p.vx = nd.p.vy = 0; continue; }
    const cp = nd.kind === 'session' && convPin(nd);
    if (cp) { nd.p.x = cp.x; nd.p.y = cp.y; nd.p.vx = nd.p.vy = 0; continue; }
    const pull = (nd.kind === 'repo' ? 0.03 : nd.kind === 'session' ? 0.004 : 0.001) * al;
    nd.p.vx -= (nd.p.x - h.x) * pull; nd.p.vy -= (nd.p.y - h.y) * pull;
    nd.p.vx *= 0.55; nd.p.vy *= 0.55;
    const v = Math.hypot(nd.p.vx, nd.p.vy);
    if (v > 14) { nd.p.vx *= 14 / v; nd.p.vy *= 14 / v; }
    nd.p.x += nd.p.vx; nd.p.y += nd.p.vy;
  }
  separate(0.3);
  I.alpha *= 0.985;
}

// Push apart whatever is closer than the hard spacing above: whole repo groups first (hub and members move
// together, so a group keeps its shape), then single nodes. Moves a share of the overlap per call, so it eases
// apart over a few frames. Returns the largest move (0 when nothing overlaps).
function separate(share) {
  const ns = I.sim;
  if (!ns || ns.length < 2) return 0;
  let most = 0;
  const groups = new Map(); // repo id -> { hub, members, ext }
  const ext = groupExt(ns);
  for (const n of ns) if (n.kind === 'repo' && n.p) groups.set(n.id, { hub: n, members: [], ext: ext.get(n.id) || 40 });
  for (const n of ns) { const g = n.kind !== 'repo' && n.p && groups.get(n.cl); if (g) g.members.push(n); }
  const gs = [...groups.values()];
  const shift = (g, dx, dy) => {
    if (!dx && !dy) return;
    for (const n of [g.hub, ...g.members]) { n.p.x += dx; n.p.y += dy; }
    const h = I.homeXY.get(g.hub.id);
    if (h && !h.pin) { h.x += dx; h.y += dy; I.spotsMoved = true; }
  };
  // not while a re-arrange's groups glide to their new spots and settle there (rearrange): they pass through each
  // other on the way and arrive stretched, and pushing them apart then moved their spots too, which scrambled a
  // sorted layout
  if (!(performance.now() < I.regrid)) for (let i = 0; i < gs.length; i++) for (let j = i + 1; j < gs.length; j++) {
    const a = gs[i], b = gs[j];
    let dx = b.hub.p.x - a.hub.p.x, dy = b.hub.p.y - a.hub.p.y, d = Math.hypot(dx, dy);
    const want = a.ext + b.ext + 2 * CLUSTER_PAD + CLUSTER_GAP;
    if (d >= want) continue;
    const pa = pinned(a.hub.id), pb = pinned(b.hub.id);
    if (pa && pb) continue; // both placed by hand: left as they are
    if (d < 0.5) { const t = hashNum(a.hub.id + b.hub.id) * TAU; dx = Math.cos(t); dy = Math.sin(t); d = 1; }
    const m = (want - d) * share, ma = pa ? 0 : pb ? m : m / 2, mb = pb ? 0 : pa ? m : m / 2;
    shift(a, (-dx / d) * ma, (-dy / d) * ma); shift(b, (dx / d) * mb, (dy / d) * mb);
    most = Math.max(most, ma, mb);
  }
  for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) {
    const a = ns[i], b = ns[j];
    if (!a.p || !b.p || a.kind === 'repo' || b.kind === 'repo') continue;
    const same = a.cl === b.cl && a.cl !== '_none';
    if (same && (a.kind !== 'session' || b.kind !== 'session')) continue;
    const want = same ? APART_SAME : APART_OTHER;
    let dx = b.p.x - a.p.x, dy = b.p.y - a.p.y, d = Math.hypot(dx, dy);
    if (d >= want) continue;
    if (d < 0.5) { const t = hashNum(a.id + b.id) * TAU; dx = Math.cos(t); dy = Math.sin(t); d = 1; }
    // a conversation placed by hand stays put: the other one makes way
    const pa = a.kind === 'session' && pinned(a.id), pb = b.kind === 'session' && pinned(b.id);
    if (pa && pb) continue;
    const m = (want - d) * share, ma = pa ? 0 : pb ? m : m / 2, mb = pb ? 0 : pa ? m : m / 2;
    a.p.x -= (dx / d) * ma; a.p.y -= (dy / d) * ma; b.p.x += (dx / d) * mb; b.p.y += (dy / d) * mb;
    most = Math.max(most, m);
  }
  return most;
}

// How far each repo's conversations and PRs reach from its hub (at least 40): the group's size for spacing.
// Recent files and clash nodes don't count: they come and go, and a clash sits between two repos, so counting
// them pushed whole repos apart and nothing brought them back.
function groupExt(nodes) {
  const hubs = new Map(), ext = new Map();
  for (const n of nodes) { const p = n.kind === 'repo' && I.pos.get(n.id); if (p) { hubs.set(n.id, p); ext.set(n.id, 40); } }
  for (const n of nodes) {
    if (n.kind !== 'session' && n.kind !== 'pr') continue;
    const h = hubs.get(n.cl), p = I.pos.get(n.id);
    if (h && p) ext.set(n.cl, Math.max(ext.get(n.cl), Math.hypot(p.x - h.x, p.y - h.y)));
  }
  return ext;
}

// Glide each repo's whole group (its hub and everything on it) a share of the way to its grid home, so the map
// always ends on the packed layout assignHomes picked to fit the window, not wherever the forces left it.
// Returns the largest move.
function gather(share = 0.03) {
  const ns = I.sim;
  if (!ns || !I.homeXY) return 0;
  const moves = new Map();
  let most = 0;
  for (const n of ns) {
    const h = n.kind === 'repo' && n.p && I.homeXY.get(n.id);
    if (!h) continue;
    const dx = (h.x - n.p.x) * share, dy = (h.y - n.p.y) * share;
    moves.set(n.id, { dx, dy });
    most = Math.max(most, Math.hypot(dx, dy));
  }
  if (most < 0.05) return most;
  for (const n of ns) { const m = n.p && moves.get(n.kind === 'repo' ? n.id : n.cl); if (m) { n.p.x += m.dx; n.p.y += m.dy; } }
  return most;
}

// ---------- camera ----------
function camTarget() {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const n of I.sim || []) { x0 = Math.min(x0, n.p.x); x1 = Math.max(x1, n.p.x); y0 = Math.min(y0, n.p.y); y1 = Math.max(y1, n.p.y); }
  if (!isFinite(x0)) { x0 = y0 = -100; x1 = y1 = 100; }
  // room for orbiting agents and labels around the edge
  const bw = Math.max(200, x1 - x0 + 260), bh = Math.max(200, y1 - y0 + 130);
  const fit = clamp(Math.min((I.W - 60) / bw, (I.H - 60) / bh), 0.25, 1.5);
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, fit };
}
function updateCamera(snap) {
  const t = camTarget();
  if (!I.cam || snap) { I.cam = t; return false; }
  const c = I.cam;
  const moving = Math.abs(t.cx - c.cx) > 0.3 || Math.abs(t.cy - c.cy) > 0.3 || Math.abs(t.fit / c.fit - 1) > 0.002;
  c.cx += (t.cx - c.cx) * 0.1; c.cy += (t.cy - c.cy) * 0.1;
  c.fit *= Math.pow(t.fit / c.fit, 0.1);
  return moving;
}
const K = () => I.cam.fit * I.zoom;
const toScreen = (x, y) => [(x - I.cam.cx - I.pan.x) * K() + I.W / 2, (y - I.cam.cy - I.pan.y) * K() + I.H / 2];
const toWorld = (sx, sy) => [(sx - I.W / 2) / K() + I.cam.cx + I.pan.x, (sy - I.H / 2) / K() + I.cam.cy + I.pan.y];

// drop the hand's pan and zoom; the camera fits everything shown for the next ms
function recenter(ms) {
  I.pan = { x: 0, y: 0 }; I.zoom = 1; I.camUntil = performance.now() + ms;
  zoomAt(I.W / 2, I.H / 2, 1);
}

// Where you were looking, kept across reloads and restarts: the world point at the top-left corner (a resize holds
// that corner, see frame) and the drawn scale, as settings.mapCamera { x, y, k }
function cleanCam(c) {
  return c && [c.x, c.y, c.k].every(Number.isFinite) && c.k > 0 ? { x: c.x, y: c.y, k: c.k } : null;
}
// the first frame with something on the map opens on the saved view, and the camera's fit holds still from then
// on; unless nothing at all would be on screen there (then the fit stays)
function restoreCam() {
  const c = I.savedCam;
  I.savedCam = null;
  const zoom = clamp(c.k / I.cam.fit, ZMIN, ZMAX), k = I.cam.fit * zoom;
  const pan = { x: c.x - I.cam.cx + I.W / (2 * k), y: c.y - I.cam.cy + I.H / (2 * k) };
  const seen = I.sim.some((n) => {
    const sx = (n.p.x - I.cam.cx - pan.x) * k + I.W / 2, sy = (n.p.y - I.cam.cy - pan.y) * k + I.H / 2;
    return sx > 0 && sx < I.W && sy > 0 && sy < I.H;
  });
  if (!seen) return;
  I.pan = pan; I.zoom = zoom; I.glide = null;
  I.camUntil = -1;
  I.dirty = true;
}
// saved whenever it changes (the shell batches saves, and sends what waits when the window closes)
function keepCam() {
  if (I.replay || !I.W || !I.H) return;
  const [x, y] = toWorld(0, 0);
  const c = { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, k: Math.round(K() * 1000) / 1000 };
  const sig = `${c.x},${c.y},${c.k}`;
  if (sig === I.camSig) return;
  const first = !I.camSig;
  I.camSig = sig;
  if (first) return; // the view it opened on: nothing moved yet
  try { I.ui.saveSettings && I.ui.saveSettings({ mapCamera: c }); } catch { /* shell gone */ }
}

function zoomAt(sx, sy, factor) {
  if (!I.cam) return;
  I.glide = null; // the hand wins over a glide
  const [wx, wy] = toWorld(sx, sy);
  I.zoom = clamp(I.zoom * factor, ZMIN, ZMAX);
  const [nx, ny] = toWorld(sx, sy);
  holdPan(wx - nx, wy - ny); // the pan that keeps the point under the pointer; the sky takes it back out
  I.dirty = true;
  saveZoomSoon();
}

// a pan that only makes up for the map moving or resizing on screen (a menu or panel opening): the starfield
// takes it back out (starAdj), so the stars hold still in the window as well
function holdPan(dx, dy) {
  I.pan.x += dx; I.pan.y += dy;
  const a = I.starAdj || (I.starAdj = { x: 0, y: 0 });
  a.x += dx; a.y += dy;
}

// the repos and conversations on screen now (at their last drawn place)
function onScreenIds() {
  const ids = new Set();
  for (const n of I.sim || []) if (n.sx >= 0 && n.sx <= I.W && n.sy >= 0 && n.sy <= I.H) ids.add(n.id);
  return ids;
}
// after the map moved or shrank (a panel opening on its left or right): any of ids that was on screen and is now
// off it brings the view along in one glide, so nothing ends up under the panel. The view moves as little as it
// can (KEEP_PAD from the edge) and zooms out only when they no longer fit. Nothing pushed off: it holds still.
function keepIn(ids) {
  const ns = (I.sim || []).filter((n) => ids.has(n.id) && n.p);
  if (!ns.length || !I.cam) return;
  if (!ns.some((n) => n.sx < 0 || n.sx > I.W || n.sy < 0 || n.sy > I.H)) return;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const n of ns) { x0 = Math.min(x0, n.p.x); x1 = Math.max(x1, n.p.x); y0 = Math.min(y0, n.p.y); y1 = Math.max(y1, n.p.y); }
  const m = KEEP_PAD * (I.sf || 1), k = K();
  const f = Math.min(1, (I.W - 2 * m) / Math.max(1, (x1 - x0) * k), (I.H - 2 * m) / Math.max(1, (y1 - y0) * k));
  const zoom = clamp(I.zoom * Math.max(0.05, f), ZMIN, ZMAX), k2 = I.cam.fit * zoom;
  let [cx, cy] = toWorld(I.W / 2, I.H / 2);
  const hw = (I.W / 2 - m) / k2, hh = (I.H / 2 - m) / k2;
  if (x1 - x0 > 2 * hw) cx = (x0 + x1) / 2; else if (x0 < cx - hw) cx = x0 + hw; else if (x1 > cx + hw) cx = x1 - hw;
  if (y1 - y0 > 2 * hh) cy = (y0 + y1) / 2; else if (y0 < cy - hh) cy = y0 + hh; else if (y1 > cy + hh) cy = y1 - hh;
  glideTo(cx, cy, zoom, true);
}

// ---------- frame loop ----------
function frame(ts) {
  I.raf = -1; // in a frame: a change marked now needs no wake (paceNext follows)
  // the Map shown: the map and the sky; any other view: the sky alone, behind it
  I.mapOn = active();
  if (document.hidden || !(I.mapOn || skyOn())) { stop(); return; }
  const P = I.pace;
  if (P.chain && ts - P.ts > 3 && ts - P.ts < 50) paceSample(P, ts - P.ts);
  P.ts = ts; P.chain = false;
  I.still = !!(I.reduce && I.reduce.matches);
  // an ambient frame that came before its refresh (the sleep ended early): wait for that one
  if (!I.still && P.at && ts < P.at - P.ms / 2 && !quickNow()) { later(P.at); return; }
  const t0 = performance.now();
  // at rest the ambient motion holds still (its clock and turns stop; changes still glide), and goes on from there
  // after (the frame after a rest tick counts one refresh, so nothing jumps)
  const rest = !I.still && resting(), tick = rest && !quickNow();
  const dt = I.lastT ? Math.min(100, t0 - I.lastT) : 16;
  I.lastT = tick ? 0 : t0; I.dt = dt; I.adt = rest ? 0 : dt;
  if (!I.still) I.time += I.adt;
  const dpr = window.devicePixelRatio || 1;
  I.dpr = dpr;
  if (I.skyEl) skySize(dpr);
  if (I.mapOn) mapFrame(t0, dpr);
  meteorStep(t0, rest);
  eventStep(t0, rest);
  farStep(t0, rest);
  satStep(rest);
  rocketStep(t0, rest);
  // continuous motion while anything moves (the stars' drift too, even on an empty map), at the pace paceNext
  // sets; otherwise only on change (and a slow tick for age fades)
  const moving = (!I.still && !tick) || I.meteors.length > 0 || I.rockets.length > 0 || I.events.size > 0 || !!I.far ||
    (I.mapOn && (I.comets.length > 0 || I.cometQ.length > 0 || I.ghosts.length > 0 || I.bursts.length > 0));
  const hot = I._dirty;
  if (hot || moving || t0 - I.lastDraw > (tick ? REST_TICK_MS - 50 : 250)) {
    I.quick = false; I.lively = false; // what this draw finds going on (see quickNow, paceNext)
    if (I.mapOn) draw(); else drawSkyOnly();
    I.lastDraw = t0; I._dirty = false;
    P.draws.push(t0);
    while (P.draws[0] < t0 - 1000) P.draws.shift();
    const ms = performance.now() - t0, s = I.stats;
    s.frames++;
    s.sum += ms - (s.n === s.ring.length ? s.ring[s.i] : 0);
    s.ring[s.i] = ms; s.i = (s.i + 1) % s.ring.length; s.n = Math.min(s.ring.length, s.n + 1);
    if (ms > s.max) s.max = ms;
  }
  // the overlay (edge pointers, minimap, ...) follows every frame; its errors never stop the map
  if (I.mapOn && I.overlay && typeof I.overlay.frame === 'function') { try { I.overlay.frame(performance.now()); } catch (err) { console.error(err); } }
  paceNext(ts, hot);
}

// the map's part of a frame (the Map shown): its box, the layout, the camera
function mapFrame(t0, dpr) {
  const r = I.el.getBoundingClientRect();
  // the strips above the map (the alert line, Recently finished) change height without changing its size much:
  // its top edge moves on screen, and the view must not move with it
  const top0 = I.top, left0 = I.left;
  I.top = r.top; I.left = r.left;
  const shifted = I.cam && top0 != null && (Math.abs(r.top - top0) >= 0.5 || Math.abs(r.left - left0) >= 0.5);
  const resized = I.sized && (Math.round(r.width) !== I.W || Math.round(r.height) !== I.H);
  // a panel opening beside the map: note what is on screen before it moves, to bring back what it pushes off (keepIn)
  if ((shifted || resized) && I.camInit) {
    if (!I.keep) I.keep = { ids: onScreenIds() };
    I.keep.at = t0;
  }
  if (shifted) { holdPan((r.left - left0) / K(), (r.top - top0) / K()); I.dirty = true; }
  if (!I.sized || Math.round(r.width) !== I.W || Math.round(r.height) !== I.H || dpr !== I.mapDpr) {
    I.sized = true;
    const W0 = I.W, H0 = I.H;
    I.W = Math.round(r.width); I.H = Math.round(r.height); I.mapDpr = dpr;
    I.sf = screenFactor(I.W, I.H);
    I.canvas.width = Math.max(1, Math.round(I.W * dpr)); I.canvas.height = Math.max(1, Math.round(I.H * dpr));
    const before = I.homeSig;
    assignHomes(I.nodes);
    if (before && before !== I.homeSig) I.alpha = Math.max(I.alpha, 0.3);
    if (!I.camInit) { updateCamera(true); I.camInit = true; }
    else if (I.cam && W0 && H0) {
      // a resized map (the panel opening, the window) doesn't move the view: what's on screen stays put,
      // held by its top-left corner (the panel takes room from the right), and by where that corner is on
      // screen (above)
      holdPan((I.W - W0) / (2 * K()), (I.H - H0) / (2 * K()));
    }
    I.dirty = true;
  }
  if (I.keep && t0 - I.keep.at > KEEP_SETTLE_MS) { const ids = I.keep.ids; I.keep = null; if (!I.drag) keepIn(ids); }
  if (t0 < I.regrid) I.alpha = Math.max(I.alpha, 0.3); // a re-arrange: the forces keep going until the groups have their shape back
  if (I.alpha > 0.01) { simStep(); simStep(); I.dirty = true; }
  else if (separate(0.15) > 0.05) I.dirty = true; // settled: still never let anything sit too close
  if (gather() > 0.05) I.dirty = true;
  if (trailStep(t0)) I.dirty = true;
  if (I.spotsMoved) { I.spotsMoved = false; saveSpotsSoon(3000); }
  if (I.spotsDue && Date.now() - I.spotsDue > 5000) sendSpots(); // no new state came (unchanged): send it anyway
  // the camera fits the map when it first shows (and on 0 or a re-arrange), then holds still: changes never pan
  // or zoom the view by themselves
  if (!(I.drag && I.drag.node) && performance.now() < (I.camUntil || Infinity) && updateCamera(false)) I.dirty = true;
  if (stepGlide(t0)) I.dirty = true;
  if (I.savedCam && I.camInit && I.sim && I.sim.length) restoreCam();
  if (I.camInit && !I.savedCam) keepCam();
}

// ---------- drawing ----------
// screen factor: 1 up to a ~1600x900 window, growing on bigger ones (about 1.45 on a 4K screen) so the map doesn't
// turn into tiny dots; sizes in px (orbs via ksOf, label fonts and pills via font and I.sf) multiply by it
function screenFactor(W, H) { return clamp(Math.sqrt(Math.min((W || 0) / 1600, (H || 0) / 900)), 1, 1.6); }
// the size scale for orbs, rings and lines: the zoom part clamped, then the screen factor
function ksOf(k) { return clamp(Math.sqrt(k || 1), 0.8, 1.35) * (I.sf || 1); }
// label fonts grow with the screen factor (not with zoom)
function font(px, weight = 400, fam = UI) { return `${weight} ${Math.round(px * (I.sf || 1) * 2) / 2}px ${fam}`; }
function measure(ctx, f, text) {
  const key = f + '|' + text;
  let w = I.measure.get(key);
  if (w === undefined) {
    ctx.font = f; w = ctx.measureText(text).width;
    if (I.measure.size > 4000) I.measure.clear();
    I.measure.set(key, w);
  }
  return w;
}
// wrap at spaces, dashes, underscores and slashes; never cut a name, only break it
function wrap(ctx, f, text, maxW) {
  const tokens = String(text).match(/[^\s\-_/]+[\s\-_/]*|[\s\-_/]+/g) || [String(text)];
  const lines = [];
  let cur = '';
  const pushLong = (tok) => {
    let part = '';
    for (const ch of tok) {
      if (part && measure(ctx, f, part + ch) > maxW) { lines.push(part); part = ''; }
      part += ch;
    }
    return part;
  };
  for (const tok of tokens) {
    if (!cur) { cur = measure(ctx, f, tok.trimEnd()) > maxW ? pushLong(tok) : tok; continue; }
    if (measure(ctx, f, (cur + tok).trimEnd()) <= maxW) cur += tok;
    else { lines.push(cur.trimEnd()); cur = measure(ctx, f, tok.trimEnd()) > maxW ? pushLong(tok) : tok; }
  }
  if (cur.trim()) lines.push(cur.trimEnd());
  return lines.length ? lines : [String(text)];
}

function sessionRadius(s, ks) {
  const base = s.state === 'DONE' ? 7 : 7.5 + Math.min(5, Math.sqrt(s.calls20 || 0) * 0.9);
  return base * ks;
}

// ---------- paint: gradients are built once per colour in unit space and drawn through a transform ----------
// (a canvas gradient is fixed to its coordinates, so a unit gradient placed with setTransform can be reused
// by every node of that colour at any size and position; nothing is allocated per frame for them)
const WHITE = [255, 255, 255], BLACK = [5, 7, 13];
const RGB = new Map(), RGBA = new Map();
function hexRgb(hex) {
  let v = RGB.get(hex);
  if (!v) {
    const h = String(hex || COL.dim);
    v = [parseInt(h.slice(1, 3), 16) || 0, parseInt(h.slice(3, 5), 16) || 0, parseInt(h.slice(5, 7), 16) || 0];
    RGB.set(hex, v);
  }
  return v;
}
function rgba(hex, a) {
  hex = hex || COL.dim;
  a = Math.round(a * 100) / 100;
  let m = RGBA.get(hex);
  if (!m) RGBA.set(hex, (m = new Map()));
  let s = m.get(a);
  if (!s) { const c = hexRgb(hex); s = `rgba(${c[0]},${c[1]},${c[2]},${a})`; m.set(a, s); }
  return s;
}
// a hex colour taken part of the way to another (hex too, so orb() can build its gradient from it)
const HEXMIX = new Map();
function mixHex(hex, to, t) {
  const k = hex + to + t;
  let v = HEXMIX.get(k);
  if (!v) {
    const a = hexRgb(hex), b = hexRgb(to);
    v = '#' + a.map((c, i) => Math.round(c + (b[i] - c) * t).toString(16).padStart(2, '0')).join('');
    HEXMIX.set(k, v);
  }
  return v;
}
function mix(hex, to, t) {
  const c = hexRgb(hex || COL.dim);
  return `rgb(${Math.round(c[0] + (to[0] - c[0]) * t)},${Math.round(c[1] + (to[1] - c[1]) * t)},${Math.round(c[2] + (to[2] - c[2]) * t)})`;
}
// cache(kind, a, b, build): one gradient per kind and colour pair, for the life of the canvas
function cache(kind, a, b, build) {
  const P = I.paint || (I.paint = new Map());
  let m1 = P.get(kind);
  if (!m1) P.set(kind, (m1 = new Map()));
  let m2 = m1.get(a);
  if (!m2) m1.set(a, (m2 = new Map()));
  let g = m2.get(b);
  if (!g) { g = build(I.ctx, a, b); m2.set(b, g); }
  return g;
}
const buildOrb = (c, hue) => {
  // light from the top left: a lighter tint, then the hue, then a darker rim
  const g = c.createRadialGradient(-0.36, -0.42, 0.04, 0, 0, 1.04);
  g.addColorStop(0, mix(hue, WHITE, 0.55)); g.addColorStop(0.5, hue); g.addColorStop(1, mix(hue, BLACK, 0.45));
  return g;
};
const buildAura = (c, hue) => {
  const g = c.createRadialGradient(0, 0, 0, 0, 0, 1);
  g.addColorStop(0, rgba(hue, AURA_ALPHA)); g.addColorStop(0.5, rgba(hue, AURA_ALPHA * 0.42)); g.addColorStop(1, rgba(hue, 0));
  return g;
};
// a nebula lobe: a soft, roughly gaussian falloff to nothing, so no edge ever shows
const buildNeb = (c, hue, a) => {
  const g = c.createRadialGradient(0, 0, 0, 0, 0, 1);
  g.addColorStop(0, rgba(hue, a)); g.addColorStop(0.3, rgba(hue, a * 0.8)); g.addColorStop(0.55, rgba(hue, a * 0.45));
  g.addColorStop(0.8, rgba(hue, a * 0.14)); g.addColorStop(1, rgba(hue, 0));
  return g;
};
const buildDiamond = (c, hue) => {
  const g = c.createLinearGradient(-0.5, -1, 0.5, 1);
  g.addColorStop(0, mix(hue, WHITE, 0.42)); g.addColorStop(0.5, hue); g.addColorStop(1, mix(hue, BLACK, 0.38));
  return g;
};
// along an edge drawn in its own frame: (0,0) is the source, (1,0) the target
const buildEdge = (alpha) => (c, a, b) => {
  const g = c.createLinearGradient(0, 0, 1, 0);
  g.addColorStop(0, rgba(a, alpha)); g.addColorStop(1, rgba(b, alpha));
  return g;
};
// finished chats' links stay at 20% so one pinned far from its repo still reads as linked
const EDGE_LIVE_A = 0.3, EDGE_DONE_A = 0.2;
const EDGE_LIVE = buildEdge(EDGE_LIVE_A), EDGE_DONE = buildEdge(EDGE_DONE_A);

// transforms: unit space at (x, y) scaled by s, an edge's own frame, and back to plain screen pixels
function unit(ctx, x, y, s) { const d = I.dpr; ctx.setTransform(d * s, 0, 0, d * s, d * x, d * y); }
function screen(ctx) { const d = I.dpr; ctx.setTransform(d, 0, 0, d, 0, 0); }

function orb(ctx, x, y, r, hue) {
  if (r < 0.5) return;
  unit(ctx, x, y, r);
  ctx.fillStyle = cache('orb', hue || COL.dim, '', buildOrb);
  ctx.beginPath(); ctx.arc(0, 0, 1, 0, TAU); ctx.fill();
  // a faint 1px rim highlight along the lit side
  if (r >= 2.5) {
    ctx.strokeStyle = 'rgba(255,255,255,0.24)'; ctx.lineWidth = 1 / r;
    ctx.beginPath(); ctx.arc(0, 0, 1 - 0.5 / r, Math.PI * 1.06, Math.PI * 1.78); ctx.stroke();
  }
  screen(ctx);
}

// Curved edges: a quadratic bend of 22% of the length (capped at BEND_MAX px, scaled with the zoom), always to
// the same side for a given pair (the side comes from both ends' hashes, so it holds whichever end draws it).
// The bend sways slowly, like a rope between two drifting nodes: the amount, never the brightness. Every edge
// drawer, hit test and comet asks bendAmt, so they all agree on the curve in the same frame.
const BEND = 0.22, BEND_MAX = 96;      // share of the length; cap in px at ks 1
const SWAY = 0.18, SWAY_S = [9, 7];    // bend sways ±18%, each pair's period 9-16 s
let bendCap = BEND_MAX;                // BEND_MAX × this frame's ks (set in draw)
const CP = { x: 0, y: 0 };
function bendSide(a, b) {
  const s = ((a.h + b.h) * 977) % 1 < 0.5 ? 1 : -1;
  return a.h <= b.h ? s : -s;
}
// the signed bend in px for a pair d px apart (0 for straight links); symmetric in a and b apart from the side
function bendAmt(a, b, d) {
  if (a.kind === 'agent' || b.kind === 'agent') return 0;
  let s = Math.min(d * BEND, bendCap);
  if (!I.still) {
    const ph = ((a.h + b.h) * 613) % 1, per = SWAY_S[0] + SWAY_S[1] * ((a.h * b.h * 7919) % 1);
    s *= 1 + SWAY * Math.sin((I.time / 1000 / per + ph) * TAU);
  }
  return bendSide(a, b) * s;
}
function bend(a, b) {
  const dx = b.sx - a.sx, dy = b.sy - a.sy, d = Math.hypot(dx, dy) || 1;
  const s = bendAmt(a, b, d);
  CP.x = (a.sx + b.sx) / 2 - (dy / d) * s; CP.y = (a.sy + b.sy) / 2 + (dx / d) * s;
  return CP;
}
function curve(ctx, a, b) {
  const c = bend(a, b);
  ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.quadraticCurveTo(c.x, c.y, b.sx, b.sy); ctx.stroke();
}
// a curve with a gradient from source colour to target colour, drawn in the edge's own frame
function gradCurve(ctx, a, b, ca, cb, width, done) {
  const dx = b.sx - a.sx, dy = b.sy - a.sy, d = Math.hypot(dx, dy);
  if (d < 2) return;
  const s = bendAmt(a, b, d) / d;
  const p = I.dpr;
  ctx.setTransform(p * dx, p * dy, -p * dy, p * dx, p * a.sx, p * a.sy);
  ctx.strokeStyle = cache(done ? 'eD' : 'eL', ca || COL.dim, cb || COL.dim, done ? EDGE_DONE : EDGE_LIVE);
  ctx.lineWidth = width / d;
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(0.5, s, 1, 0); ctx.stroke();
  screen(ctx);
}

// a puff's lobes, seeded from its node's id: the core in the middle (lobe 0), then NEB_LOBES around it; lit is
// where its whiter spot sits (on one of the lobes)
function puffLobes(id) {
  const L = [], a0 = hashNum(id + 'na') * TAU, w = (sfx) => TAU / (NEB_PERIOD[0] + NEB_PERIOD[1] * hashNum(id + sfx));
  for (let i = 0; i <= NEB_LOBES; i++) {
    const h = (sfx) => hashNum(id + sfx + i);
    const ang = a0 + ((i - 1) * TAU) / NEB_LOBES + (h('nj') - 0.5) * 1.2;
    const d = i ? NEB_OFF[0] + (NEB_OFF[1] - NEB_OFF[0]) * h('nd') : 0.06 * h('nd');
    L.push({ x: Math.cos(ang) * d, y: Math.sin(ang) * d, s: i ? NEB_SIZE[0] + (NEB_SIZE[1] - NEB_SIZE[0]) * h('ns') : 1,
      a: i ? NEB_LOBE_A : 1,
      w1: w('w1' + i), p1: h('p1') * TAU, w2: w('w2' + i), p2: h('p2') * TAU, w3: w('w3' + i), p3: h('p3') * TAU });
  }
  return { lobes: L, lit: 1 + Math.floor(hashNum(id + 'nl') * NEB_LOBES) };
}

// the white field's falloff (one gradient, on the field's own canvas) and each colour's lit spot
function fieldCanvas() {
  const w = Math.max(1, Math.ceil(I.W * NEB_RES)), h = Math.max(1, Math.ceil(I.H * NEB_RES));
  let F = I.field;
  if (!F) {
    const c = document.createElement('canvas'), g = c.getContext('2d');
    F = I.field = { c, g, grad: buildNeb(g, '#ffffff', 1), lit: new Map(), core: new Map(), edge: new Map(), noise: null };
    try { const t = noiseTile(); F.noise = [g.createPattern(t, 'repeat'), g.createPattern(t, 'repeat')]; } catch { F.noise = null; }
  }
  if (F.c.width !== w || F.c.height !== h) { F.c.width = w; F.c.height = h; }
  return F;
}
function fieldLit(F, hex) {
  let g = F.lit.get(hex);
  if (!g) F.lit.set(hex, (g = buildNeb(F.g, mixHex(hex, '#ffffff', NEB_LIGHT), 1)));
  return g;
}
function fieldCore(F, hex) {
  let g = F.core.get(hex);
  if (!g) F.core.set(hex, (g = buildNeb(F.g, hex, 1)));
  return g;
}
function fieldEdge(F, hex) {
  let v = F.edge.get(hex);
  if (!v) F.edge.set(hex, (v = mixHex(hueTurn(hex, NEB_EDGE_HUE), '#05070d', NEB_EDGE_DARK)));
  return v;
}
// a hex colour with its hue turned deg degrees (saturation and lightness kept)
function hueTurn(hex, deg) {
  const [r, g, b] = hexRgb(hex).map((c) => c / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  if (!d) return hex;
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (((h * 60 + deg) % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [R, G, B] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return '#' + [R, G, B].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('');
}
// a tileable fractal noise, white with the noise as alpha (bright, ragged patches over a clear background), made once
let noiseC = null;
function noiseTile() {
  if (noiseC) return noiseC;
  const T = 128, c = document.createElement('canvas');
  c.width = c.height = T;
  const g = c.getContext('2d'), img = g.createImageData(T, T), v = new Float32Array(T * T);
  let seed = 0x9e3779b9;
  const rnd = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  let amp = 1, tot = 0;
  for (const n of [3, 6, 12, 24]) {
    const lat = Array.from({ length: n * n }, rnd), at = (i, j) => lat[((j + n) % n) * n + ((i + n) % n)];
    for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) {
      const fx = (x / T) * n, fy = (y / T) * n, i = Math.floor(fx), j = Math.floor(fy);
      let u = fx - i, w = fy - j;
      u = u * u * (3 - 2 * u); w = w * w * (3 - 2 * w);
      const a = at(i, j) + (at(i + 1, j) - at(i, j)) * u, b = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * u;
      v[y * T + x] += (a + (b - a) * w) * amp;
    }
    tot += amp; amp *= 0.5;
  }
  for (let i = 0; i < T * T; i++) {
    const t = clamp((v[i] / tot - 0.38) / 0.34, 0, 1);
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255;
    img.data[i * 4 + 3] = Math.round(t * t * (3 - 2 * t) * 255);
  }
  g.putImageData(img, 0, 0);
  return (noiseC = c);
}

// repo glow (see NEB_*): puffs are kept by node id (I.puffs) so they fade in and out; this frame's puffs by repo,
// each with its screen place (sx, sy), radius R and strength a, or null when there are none. The sky's shader
// draws them (drawSkyGL), or the canvas does (drawTerritories).
function territoryPuffs(k, ks, ox, oy) {
  const P = I.puffs || (I.puffs = new Map());
  const first = !P.size; // the map's first frame: what is there already shows at once
  const ease = I.still ? 1 : 1 - Math.exp(-(I.dt || 16) / (NEB_FADE_MS / 3));
  const live = new Set();
  const put = (m, repo, kind) => {
    let p = P.get(m.id);
    if (!p) P.set(m.id, (p = { w: 0, ...puffLobes(m.id) }));
    p.repo = repo.id; p.color = repo.color || COL.dim; p.kind = kind; p.x = m.p.x; p.y = m.p.y;
    p.want = kind === 'session' && m.s && m.s.state === 'DONE' ? NEB_DONE : 1;
    if (first) p.w = p.want;
    live.add(m.id);
  };
  for (const n of I.nodes) {
    if (n.kind !== 'repo' || !n.p) continue;
    put(n, n, 'repo');
    for (const m of n.members) if (m.p) put(m, n, m.kind === 'pr' ? 'pr' : 'session');
  }
  // by repo, each puff's screen place and radius; one that left fades where it was
  const byRepo = new Map();
  for (const [id, p] of P) {
    if (!live.has(id)) p.want = 0;
    p.w += (p.want - p.w) * ease;
    if (Math.abs(p.want - p.w) > 0.005) I.quick = true;
    if (!live.has(id) && p.w < 0.01) { P.delete(id); continue; }
    const [wr, px, str] = NEB_PUFF[p.kind];
    p.sx = p.x * k + ox; p.sy = p.y * k + oy; p.R = wr * k + px * ks; p.a = p.w * str;
    let g = byRepo.get(p.repo);
    if (!g) byRepo.set(p.repo, (g = []));
    g.push(p);
  }
  return byRepo.size ? byRepo : null;
}
// a repo's box: everything its puffs can touch, in field px (NEB_RES of CSS px), cut to the field (w x h);
// null when none of it is on screen
function glowBox(list, w, h) {
  const q = NEB_RES;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of list) {
    const e = p.R * NEB_REACH;
    x0 = Math.min(x0, p.sx - e); y0 = Math.min(y0, p.sy - e); x1 = Math.max(x1, p.sx + e); y1 = Math.max(y1, p.sy + e);
  }
  x0 = Math.max(0, Math.floor(x0 * q)); y0 = Math.max(0, Math.floor(y0 * q));
  x1 = Math.min(w, Math.ceil(x1 * q)); y1 = Math.min(h, Math.ceil(y1 * q));
  return x1 - x0 < 1 || y1 - y0 < 1 ? null : { x0, y0, x1, y1 };
}
// the canvas draws the glow (no WebGL2, or ?glow2d=1): a repo's puffs are summed into the field canvas, tinted, and
// laid on the map in one drawImage per repo
function drawTerritories(ctx, k, ox, oy, byRepo) {
  if (!byRepo) return;
  const ts = I.still ? 0 : I.time / 1000;
  const F = fieldCanvas(), g = F.g, q = NEB_RES;
  for (const list of byRepo.values()) {
    const b = glowBox(list, F.c.width, F.c.height);
    if (!b) continue;
    const { x0, y0, x1, y1 } = b;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
    g.clearRect(x0, y0, x1 - x0, y1 - y0);
    // the field: every lobe of every puff, added up
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = F.grad;
    for (const p of list) {
      if (p.a < 0.004) continue;
      for (const L of p.lobes) {
        const x = p.sx + (L.x + NEB_WANDER * Math.cos(ts * L.w1 + L.p1)) * p.R;
        const y = p.sy + (L.y + NEB_WANDER * Math.sin(ts * L.w2 + L.p2)) * p.R;
        const r = p.R * L.s * (1 + NEB_BREATHE * Math.sin(ts * L.w3 + L.p3));
        g.globalAlpha = Math.min(1, p.a * L.a);
        g.setTransform(q * r, 0, 0, q * r, q * x, q * y);
        g.beginPath(); g.arc(0, 0, 1, 0, TAU); g.fill();
      }
    }
    // wisps: the noise layers cut out of the field, pinned to the map
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (F.noise) {
      g.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < F.noise.length; i++) {
        const s = (q * k * NEB_NOISE[i]) / 128, dx = ts * NEB_NOISE_DRIFT[i] * k, dy = ts * NEB_NOISE_DRIFT[1 - i] * 0.6 * k;
        F.noise[i].setTransform(new DOMMatrix([s, 0, 0, s, q * (ox + dx + i * 97 * k), q * (oy + dy + i * 53 * k)]));
        g.globalAlpha = i ? NEB_GRAIN * 0.6 : NEB_GRAIN;
        g.fillStyle = F.noise[i]; g.fillRect(x0, y0, x1 - x0, y1 - y0);
      }
      // each puff's middle filled back in, so the wisps are at the cloud's edge and the node sits in a clear glow
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = F.grad;
      for (const p of list) {
        if (p.a < 0.004) continue;
        const r = p.R * NEB_HEART[0];
        g.globalAlpha = Math.min(1, p.a * NEB_HEART[1]);
        g.setTransform(q * r, 0, 0, q * r, q * p.sx, q * p.sy);
        g.beginPath(); g.arc(0, 0, 1, 0, TAU); g.fill();
      }
      g.setTransform(1, 0, 0, 1, 0, 0);
    }
    // its colours where the field is: the edge colour, the repo's colour over each puff's middle, then a whiter
    // spot on each puff (the field's alpha stays as it is)
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = fieldEdge(F, list[0].color); g.fillRect(x0, y0, x1 - x0, y1 - y0);
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = fieldCore(F, list[0].color);
    for (const p of list) {
      if (p.a < 0.004) continue;
      const r = p.R * 1.05;
      g.globalAlpha = Math.min(1, p.w);
      g.setTransform(q * r, 0, 0, q * r, q * p.sx, q * p.sy);
      g.beginPath(); g.arc(0, 0, 1, 0, TAU); g.fill();
    }
    g.fillStyle = fieldLit(F, list[0].color);
    for (const p of list) {
      if (p.a < 0.004) continue;
      const L = p.lobes[p.lit];
      const x = p.sx + (L.x + NEB_WANDER * Math.cos(ts * L.w1 + L.p1)) * p.R;
      const y = p.sy + (L.y + NEB_WANDER * Math.sin(ts * L.w2 + L.p2)) * p.R;
      const r = p.R * 0.62 * (1 + NEB_BREATHE * Math.sin(ts * L.w3 + L.p3));
      g.globalAlpha = NEB_LIT_A * Math.min(1, p.w);
      g.setTransform(q * r, 0, 0, q * r, q * x, q * y);
      g.beginPath(); g.arc(0, 0, 1, 0, TAU); g.fill();
    }
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
    screen(ctx);
    ctx.globalAlpha = NEB_A; ctx.globalCompositeOperation = 'screen';
    ctx.drawImage(F.c, x0, y0, x1 - x0, y1 - y0, x0 / q, y0 / q, (x1 - x0) / q, (y1 - y0) / q);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  }
}

// the starfield: each layer's tile is painted once (per dpr) into an offscreen canvas and repeated: as a texture in
// the sky's shader (drawSkyGL; only the layers without a cell, it makes the others itself, STAR_FIELD_GLSL), or
// through a pattern placed with setTransform when the canvas draws the sky (drawStars, all three)
function seeded(seed) {
  let x = seed >>> 0;
  return () => { x = (x + 0x6d2b79f5) >>> 0; let t = Math.imul(x ^ (x >>> 15), 1 | x); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function starTile(L, dpr) {
  const T = STAR_TILE, c = document.createElement('canvas');
  c.width = c.height = Math.round(T * dpr);
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const rnd = seeded(L.seed);
  const lerp = (r, u) => r[0] + (r[1] - r[0]) * u, wrap = (v) => ((v % T) + T) % T;
  const tintOf = (u) => { let w = u * STAR_TINT_SUM, j = 0; while (j < STAR_TINT.length - 1 && (w -= STAR_TINT[j][1]) > 0) j++; return STAR_TINT[j][0]; };
  // loose clusters: centres anywhere on the tile, members spread about them and wrapped, so a cluster on an edge
  // carries on in the next tile
  const [nc, share, spread] = L.cl || [0, 0, 0], cs = [];
  for (let j = 0; j < nc; j++) cs.push([rnd() * T, rnd() * T]);
  for (let i = 0; i < L.n; i++) {
    let px = rnd() * T, py = rnd() * T;
    if (nc && rnd() < share) {
      const o = cs[Math.floor(rnd() * nc)];
      px = wrap(o[0] + (rnd() + rnd() + rnd() - 1.5) * spread); py = wrap(o[1] + (rnd() + rnd() + rnd() - 1.5) * spread);
    }
    const r = lerp(L.r, rnd()), a = lerp(L.a, rnd() * rnd());
    const tint = tintOf(rnd()), sp = i < (L.sparkle || 0);
    // drawn at the wrapped copies too, so a star on a tile's edge isn't cut
    for (const dx of [-T, 0, T]) for (const dy of [-T, 0, T]) {
      const X = px + dx, Y = py + dy;
      if (X < -6 || X > T + 6 || Y < -6 || Y > T + 6) continue;
      if (sp) {
        // a tiny 4-point sparkle: two crossed short lines, fixed alpha
        g.strokeStyle = `rgba(${tint},${a * 0.8})`; g.lineWidth = 0.6;
        g.beginPath(); g.moveTo(X - 3.2, Y); g.lineTo(X + 3.2, Y); g.moveTo(X, Y - 3.2); g.lineTo(X, Y + 3.2); g.stroke();
      }
      if (r >= 0.8) { g.fillStyle = `rgba(${tint},${a * 0.22})`; g.beginPath(); g.arc(X, Y, r * 2.4, 0, TAU); g.fill(); }
      g.fillStyle = `rgba(${tint},${a})`; g.beginPath(); g.arc(X, Y, r, 0, TAU); g.fill();
    }
  }
  return c;
}
// where each star layer's tile sits this frame, for drawSkyGL and drawStars: per layer its scale s and the offset
// (ex, ey) of a tile's corner in CSS px, wrapped into the first tile; and in starWide, per layer, the point of its
// star space (a tile's px, unscaled) at the map's top left, wrapped into [0, STAR_WRAP), so the shader's star space
// is never negative and stays small enough for its floats (the shader's hash repeats with it, so no seam)
const starPos = new Float64Array(STAR_LAYERS.length * 3), starWide = new Float64Array(STAR_LAYERS.length * 2);
// the sky's camera this frame: how far (cx, cy, CSS px) the sky has slid, and the field's middle (mx, my, CSS px of
// the window), which it scales about. Each change of the camera's middle (the pan, less what holdPan took back out)
// slides the sky STAR_PAN of the px it moves the map at the zoom then, so a drag carries the stars with the orbs and a
// zoom leaves them where they are. Before the Map ever showed (no camera yet) the sky has not slid; on the other views
// it stays where the map's pan last left it
function skyCam() {
  let sp = I.skyPan;
  if (I.cam) {
    const adj = I.starAdj || { x: 0, y: 0 }, k = K() * STAR_PAN;
    const rx = I.cam.cx + I.pan.x - adj.x, ry = I.cam.cy + I.pan.y - adj.y;
    if (!sp) sp = I.skyPan = { x: 0, y: 0, rx, ry };
    if (rx !== sp.rx || ry !== sp.ry) { sp.x += (rx - sp.rx) * k; sp.y += (ry - sp.ry) * k; sp.rx = rx; sp.ry = ry; }
  }
  // the field's middle is a fixed point in the window (its middle as the sky was first laid), so no menu, panel or
  // strip moves it
  if (!I.starO) I.starO = { x: (I.skyW || 1) / 2, y: (I.skyH || 1) / 2 };
  return { cx: sp ? sp.x : 0, cy: sp ? sp.y : 0, mx: I.starO.x, my: I.starO.y };
}
// the map's box in the window (CSS px): where a point on the map's canvas (a node's sx, sy) is in the sky
const mapX = () => (I.mapOn ? I.left || 0 : 0), mapY = () => (I.mapOn ? I.top || 0 : 0);
function starsAt() {
  const { cx, cy, mx, my } = skyCam(), ts = I.still ? 0 : I.time / 1000;
  for (let i = 0; i < STAR_LAYERS.length; i++) {
    const L = STAR_LAYERS[i], s = Math.pow(clamp(I.zoom || 1, ZMIN, ZMAX), L.depth * STAR_ZOOM), P = STAR_TILE * s;
    // the field scales about the screen's middle and slides with the sky (every layer alike: no parallax), plus its drift
    let ex = mx - (cx - ts * L.drift * STAR_DIR[0]) * s;
    let ey = my - (cy - ts * L.drift * STAR_DIR[1]) * s;
    const wx = -ex / s, wy = -ey / s;
    starWide[i * 2] = wx - Math.floor(wx / STAR_WRAP) * STAR_WRAP; starWide[i * 2 + 1] = wy - Math.floor(wy / STAR_WRAP) * STAR_WRAP;
    ex -= Math.floor(ex / P) * P; ey -= Math.floor(ey / P) * P;
    starPos[i * 3] = s; starPos[i * 3 + 1] = ex; starPos[i * 3 + 2] = ey;
  }
  // the deep sky the same way, left unwrapped (its band and its dust repeat at different sizes)
  const s = Math.pow(clamp(I.zoom || 1, ZMIN, ZMAX), DEEP_DEPTH * STAR_ZOOM);
  deepPos[0] = s;
  deepPos[1] = mx - (cx - ts * DEEP_DRIFT * STAR_DIR[0]) * s;
  deepPos[2] = my - (cy - ts * DEEP_DRIFT * STAR_DIR[1]) * s;
  return starPos;
}
const deepPos = new Float64Array(3);
// the deep sky's pixels, painted once: the band and the clouds (rgb: their light, scaled to the full range, as
// DEEP_A dims it in the shader; a: how dense the band's star dust is there) and the star dust tile (one byte a
// device px). Every noise repeats with the texture, and the band runs along its (2, 1) diagonal, which closes on
// itself, so the texture tiles without a seam.
let deepPix = null;
function deepSky() {
  if (deepPix) return deepPix;
  const W = DEEP_W, H = DEEP_H, rnd = seeded(71);
  const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  // value noise on a lattice of cell px that wraps with the texture, summed over octaves
  const octave = (cell) => { const gw = W / cell, gh = H / cell, v = new Float32Array(gw * gh); for (let i = 0; i < v.length; i++) v[i] = rnd(); return { cell, gw, gh, v }; };
  const val = (o, x, y) => {
    const fx = x / o.cell, fy = y / o.cell, ix = Math.floor(fx), iy = Math.floor(fy);
    const u = smooth(0, 1, fx - ix), w = smooth(0, 1, fy - iy), x1 = (ix + 1) % o.gw, y0 = iy * o.gw, y1 = ((iy + 1) % o.gh) * o.gw;
    return (o.v[y0 + ix] * (1 - u) + o.v[y0 + x1] * u) * (1 - w) + (o.v[y1 + ix] * (1 - u) + o.v[y1 + x1] * u) * w;
  };
  const fbm = (os, x, y) => { let s = 0, n = 0, k = 1; for (const o of os) { s += val(o, x, y) * k; n += k; k *= 0.5; } return s / n; };
  const glowN = [64, 32, 16, 8].map(octave), laneN = [32, 16, 8, 4].map(octave), cloudN = [64, 32, 16, 8].map(octave);
  const deep = new Uint8Array(W * H * 4), f = new Float32Array(W * H * 4);
  let top = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    // across the band (texels), which sways a little along its length
    const wv = 9 * Math.sin((TAU * x) / W) + 5 * Math.sin((TAU * 2 * x) / W + 1.3);
    const d = ((((y - 0.5 * x - wv) % H) + H * 1.5) % H - H / 2) * 0.894;
    const n1 = fbm(glowN, x, y), n2 = fbm(laneN, x, y), n3 = fbm(cloudN, x, y);
    const band = Math.exp(-((d / 30) ** 2)), core = Math.exp(-((d / 11) ** 2));
    // dark dust lanes: thin ridges of a noise, near the band's middle
    const lane = (1 - Math.abs(2 * n2 - 1)) ** 5 * Math.exp(-(((d + 4) / 16) ** 2));
    const g = (band * (0.4 + 1.1 * smooth(0.3, 0.75, n1)) + 0.6 * core * n1) * (1 - 0.85 * lane);
    // blue-white at its edges, warmer in its core
    let r = g * (0.78 + 0.22 * core), gr = g * (0.84 + 0.09 * core), b = g * (1 - 0.18 * core);
    for (const [col, cx, cy, R, str] of DEEP_CLOUDS) {
      let dx = Math.abs(x - cx) % W, dy = Math.abs(y - cy) % H;
      dx = Math.min(dx, W - dx); dy = Math.min(dy, H - dy);
      const q = (dx * dx + dy * dy) / (R * R), v = str * Math.exp(-1.8 * q) * (0.3 + smooth(0.35, 0.7, n3 + 0.15 * (1 - q)));
      r += col[0] * v; gr += col[1] * v; b += col[2] * v;
    }
    const i = (y * W + x) * 4;
    f[i] = r; f[i + 1] = gr; f[i + 2] = b;
    f[i + 3] = clamp(0.06 + band * (1 - 0.9 * lane) * (0.5 + 0.8 * n1), 0, 1);
    top = Math.max(top, r, gr, b);
  }
  // the far galaxies, in each texel the mean of 4 x 4 samples, as a share of the band's brightest light
  for (const [gx, gy, R, tilt, rot, kind, tint, hot] of DEEP_GALAXIES) {
    const co = Math.cos(rot), si = Math.sin(rot), ext = Math.ceil(R * 2.2);
    for (let oy = -ext; oy <= ext; oy++) for (let ox = -ext; ox <= ext; ox++) {
      let lr = 0, lg = 0, lb = 0;
      for (let s = 0; s < 16; s++) {
        const dx = ox + ((s % 4) + 0.5) / 4 - 0.5, dy = oy + ((s >> 2) + 0.5) / 4 - 0.5;
        // in the galaxy's own plane: turned by rot, its short axis stretched back out by the tilt
        const u = (dx * co + dy * si) / R, v = (dy * co - dx * si) / (R * tilt), q = Math.hypot(u, v);
        let arm = 0, core;
        if (kind === 'spiral') {
          // two log-spiral arms winding out from a small bright core, on a faint disc
          const ph = 2 * (Math.atan2(v, u) - Math.log(Math.max(q, 0.04)) / 0.32);
          arm = (0.5 + 0.5 * Math.cos(ph)) ** 3 * Math.exp(-q / 0.32) * smooth(0.04, 0.22, q) + 0.25 * Math.exp(-q / 0.3);
          core = Math.exp(-((q / 0.11) ** 2));
        } else {
          // smooth and fuzzy, brightening steeply to its middle
          arm = 0.55 * Math.exp(-3.4 * q ** 0.8);
          core = Math.exp(-((q / 0.2) ** 2));
        }
        // the arms take the tint, the core is warmer
        lr += tint[0] * arm + core * hot; lg += tint[1] * arm + core * hot * 0.86; lb += tint[2] * arm + core * hot * 0.68;
      }
      const x = (((gx + ox) % W) + W) % W, y = (((gy + oy) % H) + H) % H, i = (y * W + x) * 4, k = top / 16;
      f[i] += lr * k; f[i + 1] += lg * k; f[i + 2] += lb * k;
    }
  }
  for (let i = 0; i < f.length; i++) deep[i] = Math.round(Math.min(i % 4 === 3 ? f[i] : f[i] / top, 1) * 255);
  // the star dust: tiny specks, most of them very faint
  const dust = new Uint8Array(DUST_T * DUST_T);
  for (let i = 0; i < DUST_N; i++) { const j = Math.floor(rnd() * dust.length); dust[j] = Math.max(dust[j], Math.round(50 + 205 * rnd() * rnd())); }
  return (deepPix = { deep, dust });
}
// the canvas draws the stars (no WebGL2): one fillRect per layer; its tiles are painted once, so no star twinkles here
function drawStars(ctx) {
  const dpr = I.dpr || 1;
  if (!I.stars || I.stars.dpr !== dpr) {
    I.stars = { dpr, pats: STAR_LAYERS.map((L) => { try { return ctx.createPattern(starTile(L, dpr), 'repeat'); } catch { return null; } }) };
  }
  const at = starsAt();
  screen(ctx);
  for (let i = 0; i < STAR_LAYERS.length; i++) {
    const pat = I.stars.pats[i], s = at[i * 3];
    if (!pat || !pat.setTransform) continue;
    pat.setTransform(new DOMMatrix([s / dpr, 0, 0, s / dpr, at[i * 3 + 1], at[i * 3 + 2]]));
    ctx.fillStyle = pat; ctx.fillRect(0, 0, I.skyW, I.skyH);
  }
}

// ---------- shooting stars and meteor showers (see "Look", METEOR_*, SHOWER_*) ----------
const pickIn = (r) => r[0] + Math.random() * (r[1] - r[0]);
// a tint picked by STAR_TINT's weights (so mostly white)
function meteorTint() {
  let w = Math.random() * STAR_TINT_SUM, j = 0;
  while (j < STAR_TINT.length - 1 && (w -= STAR_TINT[j][1]) > 0) j++;
  return STAR_TINT[j][0].split(',').map(Number);
}
// a shooting star starting at t (ms): somewhere in the window's upper half, its direction, tail and tint; v: its speed
// (CSS px/s)
function meteorMake(t) {
  const W = I.skyW || 1, H = I.skyH || 1, ang = Math.atan2(STAR_DIR[1], STAR_DIR[0]) + (Math.random() * 2 - 1) * METEOR_TURN;
  return { at: t, x: W * pickIn([0.1, 0.9]), y: H * pickIn([0.04, 0.5]), dx: Math.cos(ang) * (Math.random() < 0.4 ? -1 : 1),
    dy: Math.sin(ang), tail: pickIn(METEOR_TAIL), v: METEOR_SPEED, rgb: meteorTint() };
}
// a meteor shower from t (ms) above hub n (or anywhere along the top when null): its streaks into I.meteors; none at
// rest, hidden or under reduced motion, nor within SHOWER_GAP of the last (unless forced); false when none started
function shower(t, n, force) {
  if (I.still || resting() || !I.running || document.hidden) return false;
  if (!force && t - I.showerAt < SHOWER_GAP) return false;
  I.showerAt = t; I.showers++;
  const W = I.skyW || 1, H = I.skyH || 1;
  const x = clamp(n && I.mapOn && Number.isFinite(n.sx) ? n.sx + mapX() : W * Math.random(), W * SHOWER_X[0], W * SHOWER_X[1]), y = H * pickIn(SHOWER_Y);
  const k = Math.floor(pickIn([SHOWER_N[0], SHOWER_N[1] + 1]));
  for (let i = 0; i < k; i++) {
    // spread over the fan in even shares, each jittered inside its own, so no two fly the same way
    const ang = Math.PI / 2 + SHOWER_FAN * (((i + 0.15 + 0.7 * Math.random()) / k) * 2 - 1), r = pickIn(SHOWER_FROM);
    const dx = Math.cos(ang), dy = Math.sin(ang);
    I.meteors.push({ at: t + (i ? Math.random() * SHOWER_MS : 0), x: x + dx * r, y: y + dy * r, dx, dy, tail: pickIn(SHOWER_TAIL),
      v: METEOR_SPEED * pickIn(SHOWER_SPEED), rgb: meteorTint() });
  }
  I.dirty = true;
  return true;
}
// each frame: none while resting or under reduced motion (and none planned), a streak ends after METEOR_MS (one more
// draw clears it), and the next shooting star comes METEOR_GAP after the last or after the map woke (never at once),
// once no streak shows
function meteorStep(t, rest) {
  const M = I.meteors;
  if (I.still || rest) {
    if (M.length) { M.length = 0; I.dirty = true; }
    I.meteorAt = 0;
    return;
  }
  let keep = 0;
  for (const m of M) if (t - m.at < METEOR_MS) M[keep++] = m;
  if (keep < M.length) { M.length = keep; I.dirty = true; }
  if (!I.meteorAt) I.meteorAt = t + pickIn(METEOR_GAP);
  else if (!M.length && t >= I.meteorAt) { M.push(meteorMake(t)); I.meteorAt = t + pickIn(METEOR_GAP); }
}
// ---------- space events (see "Look", EVENT_*) ----------
// The registry: a space event is one registerEvent(name, def) plus its own draw code (in the sky's shader and, if it
// is worth it, the canvas fallback). def: { weight, start(t) -> its state (laid out in CSS px of the window; take
// eventCam(depth) for its parallax), step(ev, t) -> false once it is over (t: the map's clock, ms), optional end(ev) }.
// The director owns the timing and the gating; an event's draw reads I.event.ev while I.event is set.
const EVENTS = new Map();
function registerEvent(name, def) { EVENTS.set(name, { weight: 1, ...def }); }
// the sky's camera for an object at `depth` (EVENT_DEPTH, or any star layer's) as it is laid: keep this next to the
// object's position at that moment, then eventAt(cam, x, y) is where that point is now, slid with the sky and scaled
// with the zoom by that fraction of it, as the satellites are (SAT_DEPTH)
function eventCam(depth) {
  const c = skyCam();
  return { ...c, depth, sc: Math.pow(clamp(I.zoom || 1, ZMIN, ZMAX), depth * STAR_ZOOM) };
}
function eventAt(cam, x, y) {
  // x, y were the window's CSS px when it was laid; it keeps its place in the window, as the stars do
  const c = skyCam(), sc = Math.pow(clamp(I.zoom || 1, ZMIN, ZMAX), cam.depth * STAR_ZOOM), k = sc / (cam.sc || sc);
  return [c.mx + (x - cam.mx) * k - (c.cx - cam.cx) * sc, c.my + (y - cam.my) * k - (c.cy - cam.cy) * sc];
}
// the running event of that kind ({ name, at, ev }), or null
const evOf = (name) => (I && I.events.get(name)) || null;
// stop the one of that kind (no name: every one running; one more draw clears it)
function eventEnd(name) {
  if (name === undefined) { for (const k of [...I.events.keys()]) eventEnd(k); return; }
  const e = I.events.get(name);
  if (!e) return;
  const d = EVENTS.get(name);
  if (d && d.end) d.end(e.ev);
  I.events.delete(name); I.dirty = true;
}
// start `name` at t (ms) beside the others running (replacing one of its own kind); false when it is not registered or
// the map is under reduced motion
function eventStart(t, name) {
  const d = EVENTS.get(name);
  if (!d || I.still) return false;
  if (I.events.has(name)) eventEnd(name);
  const e = { name, at: t, ev: null };
  e.ev = d.start(t);
  I.events.set(name, e); I.eventLast = name; I.dirty = true;
  skyLog(name, EVENT_LABELS[name] || name, null, d.ms || e.ev.ms);
  return true;
}
// tests: move the running `name` s seconds on (as if it started that much earlier)
function eventSkip(name, s) {
  const e = evOf(name);
  if (!e || !e.ev) return;
  e.at -= s * 1000;
  if (e.ev.at != null) e.ev.at -= s * 1000;
  if (EVENTS.get(name).skip) EVENTS.get(name).skip(e.ev, s * 1000);
}
// what the log calls each space event
const EVENT_LABELS = { nebula: 'Nebula drift', asteroids: 'Asteroid field', lens: 'Gravity lens (a black hole)', ship: 'Capital ship (out of hyperspace)', warp: 'Warp drift',
  planet: 'Planet (far, with its air)', battle: 'Space battle' };
// the next kind by weight, never one running, never the one shown last (unless it is the only one), never one switched
// off (null: none left); a kind that plays with one running weighs EVENT_PAIR times more (prey for a black hole, a
// black hole for prey), so the sky's sights meet
function eventPick() {
  const on = [...EVENTS.keys()].filter((k) => !I.skyOff.has(k) && !I.events.has(k));
  const ks = on.filter((k) => k !== I.eventLast);
  const pool = ks.length ? ks : on;
  if (!pool.length) return null;
  const lens = I.events.has('lens'), prey = PREY.some((k) => I.events.has(k));
  const wt = (k) => EVENTS.get(k).weight * ((lens && PREY.includes(k)) || (prey && k === 'lens') ? EVENT_PAIR : 1);
  let w = Math.random() * pool.reduce((a, k) => a + wt(k), 0);
  for (const k of pool) if ((w -= wt(k)) < 0) return k;
  return pool[pool.length - 1];
}
// each frame: none while resting or under reduced motion (the running ones end, none planned); otherwise every one running
// steps until it says it is over, then the black hole's pull (devourStep); the next comes EVENT_GAP after the last
// started (or after the map woke) while fewer than EVENT_MAX run
function eventStep(t, rest) {
  if (I.still || rest) {
    if (I.events.size) eventEnd();
    I.eventAt = 0;
    return;
  }
  for (const e of [...I.events.values()]) if (EVENTS.get(e.name).step(e.ev, t) === false) eventEnd(e.name);
  devourStep(t);
  if (!I.eventAt) I.eventAt = t + pickIn(EVENT_GAP);
  else if (t >= I.eventAt && EVENTS.size) {
    const k = I.events.size < EVENT_MAX ? eventPick() : null;
    if (k) eventStart(t, k);
    I.eventAt = t + pickIn(EVENT_GAP);
  }
}
// ---------- the nebula drift (see "Look", NEBULA_*) ----------
// start: the cloud's palette, size and straight path across the window at the far layer's depth, laid in CSS px of the
// window as the camera is now (eventCam); its middle is where `at` (ms) and its speed put it, moved on with the camera
registerEvent('nebula', {
  start(t) {
    const W = I.skyW || 1, H = I.skyH || 1, cam = eventCam(EVENT_DEPTH.far), ms = pickIn(NEBULA_MS);
    const ang = Math.atan2(STAR_DIR[1], STAR_DIR[0]) + (Math.random() * 2 - 1) * NEBULA_TURN, sg = Math.random() < 0.5 ? -1 : 1;
    const dx = Math.cos(ang) * sg, dy = Math.sin(ang) * sg, R = NEBULA_R * Math.max(W, H);
    // from where its soft edge just clears the window's far corner to where it just clears the near one, off the middle sideways
    const len = 2 * (0.85 * R + 0.5 * Math.hypot(W, H)), off = (Math.random() * 2 - 1) * NEBULA_OFF * H;
    const mx = cam.mx - dx * len / 2 - dy * off, my = cam.my - dy * len / 2 + dx * off;
    return { at: t, ms, cam, x: mx, y: my, vx: dx * len / (ms / 1000), vy: dy * len / (ms / 1000), R, aspect: pickIn(NEBULA_ASPECT),
      rot: ang + (Math.random() * 2 - 1) * 0.6, seed: Math.random(), pal: Math.floor(Math.random() * NEBULA_PALETTES.length) };
  },
  step(ev, t) { return t - ev.at < ev.ms; },
});
// the cloud as it is now, in CSS px of the window (null when none runs): its middle (x, y), long half-axis r, turn and
// aspect, seed, palette (index, colours), age (s) and alpha a (the fade at the ends of its life); the shader draws it
function nebulaNow() {
  const e = evOf('nebula');
  if (!e) return null;
  const ev = e.ev, age = Math.max(0, performance.now() - ev.at), s = age / 1000;
  const [x, y] = eventAt(ev.cam, ev.x + ev.vx * s, ev.y + ev.vy * s);
  const k = Math.pow(clamp(I.zoom || 1, ZMIN, ZMAX), EVENT_DEPTH.far * STAR_ZOOM) / ev.cam.sc;
  const fade = Math.min(1, age / NEBULA_FADE, (ev.ms - age) / NEBULA_FADE);
  if (fade <= 0) return null;
  const sm = fade * fade * (3 - 2 * fade);
  return { x, y, r: ev.R * k, rot: ev.rot, aspect: ev.aspect, seed: ev.seed, age: s, a: NEBULA_A * sm, pal: ev.pal, rgb: NEBULA_PALETTES[ev.pal] };
}
// ---------- the asteroid field (see "Look", ASTEROID_*) ----------
// start: the stream's direction and the light's (towards it, in the upper half of the sky), the field's length (a pick, or
// as long as the close rock needs) and every rock laid on its straight path in the plane of its depth (eventCam), as the
// nebula is: a rock's place along the stream is where its speed puts it so that it leaves the window at a time picked
// within the field (a slow far one may begin inside, fading in by its age), its place across it a pick
registerEvent('asteroids', {
  start(t) {
    const W = I.skyW || 1, H = I.skyH || 1, rnd = Math.random, ri = (r) => r[0] + Math.floor(rnd() * (r[1] - r[0] + 1));
    const ang = Math.atan2(STAR_DIR[1], STAR_DIR[0]) + (rnd() * 2 - 1) * ASTEROID_TURN, sg = rnd() < 0.5 ? -1 : 1;
    const bx = Math.cos(ang) * sg, by = Math.sin(ang) * sg, la = -Math.PI + 0.55 + rnd() * (Math.PI - 1.1);
    const E = 0.575 * (Math.abs(W * bx) + Math.abs(H * by)), pad = (r, bl) => 3.3 * r + 2.5 * bl + 24;
    // a close rock enters after its wait and crosses at its speed; the field lasts until it has left
    const close = rnd() < ASTEROID_CLOSE_P ? { r: pickIn(ASTEROID_CLOSE.r), v: pickIn(ASTEROID_CLOSE.v), bl: pickIn(ASTEROID_CLOSE.blur), wait: pickIn(ASTEROID_CLOSE.wait) } : null;
    let ms = pickIn(ASTEROID_MS);
    if (close) ms = Math.max(ms, (close.wait + (2 * E + 2 * pad(close.r, close.bl)) / close.v + 4) * 1000);
    const T = ms / 1000, rocks = [];
    const lay = (cam, r, v, w, bl, a0, off) => {
      const da = (rnd() * 2 - 1) * ASTEROID_STRAY, c = Math.cos(da), s = Math.sin(da);
      rocks.push({ cam, dx: bx * c - by * s, dy: bx * s + by * c, a0, off, v, r, blur: bl, asp: pickIn(ASTEROID_ASPECT), rot0: rnd() * TAU,
        w: w * (rnd() < 0.5 ? -1 : 1) * (0.4 + 0.6 * rnd()), seed: rnd() * 0.98 });
    };
    for (const L of ASTEROID_CLASSES) {
      const cam = eventCam(L.depth);
      for (let i = ri(L.n); i > 0; i--) {
        const r = pickIn(L.r), v = pickIn(L.v), p = pad(r, 0), te = T * (0.4 + 0.6 * rnd());
        lay(cam, r, v, L.w, 0, Math.min(E + p - v * te, -E + L.start * 2 * E), (rnd() * 2 - 1) * ASTEROID_OFF * H);
      }
    }
    if (close) lay(eventCam(ASTEROID_CLOSE.depth), close.r, close.v, ASTEROID_CLOSE.w, close.bl,
      -(E + pad(close.r, close.bl)) - close.v * close.wait, (rnd() * 2 - 1) * 0.28 * H);
    return { at: t, ms, rocks, light: [Math.cos(la), Math.sin(la)] };
  },
  step(ev, t) { return t - ev.at < ev.ms; },
});
// the rocks in view now, far to near, at most ASTEROID_N, in CSS px of the window: middle (x, y), long radius r, edge blur,
// alpha a (its age's fade-in), spin rot, aspect asp and seed; the shader draws them, the sharp ones before the close one
function asteroidsNow() {
  const e = evOf('asteroids');
  if (!e) return [];
  const ev = e.ev, age = Math.max(0, performance.now() - ev.at) / 1000, W = I.skyW || 1, H = I.skyH || 1, out = [];
  const fin = Math.min(1, age / ASTEROID_FADE), fade = fin * fin * (3 - 2 * fin);
  for (const o of ev.rocks) {
    const a = o.a0 + o.v * age;
    const [x, y] = eventAt(o.cam, o.cam.mx + o.dx * a - o.dy * o.off, o.cam.my + o.dy * a + o.dx * o.off);
    const k = Math.pow(clamp(I.zoom || 1, ZMIN, ZMAX), o.cam.depth * STAR_ZOOM) / o.cam.sc, r = o.r * k, bl = o.blur * k, reach = 3.3 * r + 2.5 * bl + 4;
    if (x < -reach || x > W + reach || y < -reach || y > H + reach) continue;
    out.push({ x, y, r, blur: bl, a: ASTEROID_OPACITY * fade, rot: o.rot0 + o.w * age, asp: o.asp, seed: o.seed });
    if (out.length >= ASTEROID_N) break;
  }
  return out;
}
// ---------- the gravity lens (see "Look", LENS_*) ----------
// start: the lens's straight path across the window at LENS_DEPTH (eventCam), from LENS_PAD radii off one side to as far off
// the other, as the camera is now, its radius, the direction its ring is brighter on, and for each far galaxy the line it
// slides along (its direction, its miss distance), when it lines up behind the lens and its turn
registerEvent('lens', {
  start(t) {
    const W = I.skyW || 1, H = I.skyH || 1, rnd = Math.random, cam = eventCam(LENS_DEPTH), ms = pickIn(LENS_MS), R = pickIn(LENS_R);
    const ang = Math.atan2(STAR_DIR[1], STAR_DIR[0]) + (rnd() * 2 - 1) * LENS_TURN, sg = rnd() < 0.5 ? -1 : 1;
    const dx = Math.cos(ang) * sg, dy = Math.sin(ang) * sg;
    const len = 2 * (0.575 * (Math.abs(W * dx) + Math.abs(H * dy)) + LENS_PAD * R);
    let off = (rnd() * 2 - 1) * LENS_OFF * H;
    const phi = rnd() * TAU, srcs = LENS_SRC.map((o) => ({ dir: rnd() * TAU, miss: pickIn(o.miss) * (rnd() < 0.5 ? -1 : 1), at: pickIn(o.at), rot: rnd() * TAU }));
    // prey already up: often its path is laid to cross the prey's
    const prey = PREY.map(evOf).filter((q) => q && q.ev && !q.ev.fall);
    if (prey.length && (aimForce || rnd() < DEVOUR_AIM_P)) {
      const q = prey[Math.floor(rnd() * prey.length)].ev;
      const o = aimAt(cam.mx, cam.my, dx, dy, -len / 2, len / (ms / 1000), (s) => q.free(t + s * 1000), (ms - DEVOUR_MS[1] - LENS_FADE) / 1000 - 3);
      if (o != null && Math.abs(o) < 0.5 * H) off = o;
    }
    return { at: t, ms, cam, R, x0: cam.mx - dx * len / 2 - dy * off, y0: cam.my - dy * len / 2 + dx * off, vx: dx * len / (ms / 1000), vy: dy * len / (ms / 1000),
      phi, srcs, jet: rnd() * TAU, fed: [] };
  },
  step(ev, t) { return t - ev.at < ev.ms; },
});
// the lens's place and size at `now` (ms), in CSS px of the window as the camera is now (null outside its life)
function lensPose(ev, now) {
  const age = Math.max(0, now - ev.at), fade = Math.min(1, age / LENS_FADE, (ev.ms - age) / LENS_FADE);
  if (fade <= 0) return null;
  const sm = fade * fade * (3 - 2 * fade), s = age / 1000, [x, y] = eventAt(ev.cam, ev.x0 + ev.vx * s, ev.y0 + ev.vy * s);
  return { x, y, sm, r: ev.R * sm * Math.pow(clamp(I.zoom || 1, ZMIN, ZMAX), LENS_DEPTH * STAR_ZOOM) / ev.cam.sc };
}
// the lens as it is now, in CSS px of the window (null when none runs): its middle (x, y), Einstein radius r, size share a (it
// grows from nothing over LENS_FADE at the ends of its life), its ring's bright side phi, and its galaxies: each one's place
// in the lens's plane from the lens's middle (bx, by), size sig, light amp, turn rot and aspect asp; then what it is eating:
// feed, the stream torn off the prey falling in (its distance rho and angle th from the middle, the way it winds w, its width,
// alpha a and colour), or null; and after a meal the flare (0-1: the ring's extra light and the jets'), the jets' axis jet,
// length jl and dark base jb (CSS px), and the clock t (s)
function lensNow() {
  const e = evOf('lens');
  if (!e) return null;
  const ev = e.ev, now = performance.now(), age = Math.max(0, now - ev.at), f = age / ev.ms, L = lensPose(ev, now);
  if (!L) return null;
  const { x, y, r, sm } = L;
  const srcs = LENS_SRC.map((o, i) => {
    const q = ev.srcs[i], u = LENS_SWEEP * (f - q.at), c = Math.cos(q.dir), n = Math.sin(q.dir);
    return { bx: (q.miss * -n + u * c) * r, by: (q.miss * c + u * n) * r, sig: o.sig * r, amp: o.amp * Math.exp(-((u / o.w) ** 2)), rot: q.rot, asp: o.asp };
  });
  // the stream: from the prey falling in (the last one caught), widening as it is torn up
  let feed = null;
  for (const k of PREY) {
    const pe = evOf(k);
    if (!pe || !pe.ev.fall) continue;
    const q = k === 'ship' ? shipNow() : planetNow();
    if (!q || !q.fall) continue;
    const ff = q.fall.f, size = k === 'ship' ? q.r * 0.32 : q.r * 0.55;
    feed = { rho: Math.hypot(q.x - x, q.y - y), th: Math.atan2(q.y - y, q.x - x), w: pe.ev.fall.w, width: Math.max(2, size),
      a: DEVOUR_STREAM * clamp((ff - 0.05) / 0.3, 0, 1), rgb: k === 'ship' ? [1, 0.58, 0.32] : PLANET_KINDS[pe.ev.kind][2] };
  }
  // the flare after each meal: a quick rise and a slow fall; the jets run out, then go dark from their base
  let flare = 0, jl = 0, jb = 0;
  for (const m of ev.fed) {
    const s = (now - m.at) / 1000;
    if (s < 0 || s * 1000 > DEVOUR_FLARE) continue;
    flare = Math.max(flare, clamp(s / 0.35, 0, 1) * Math.exp(-s / 2.8));
    jl = Math.max(jl, DEVOUR_JET * r * (1 - Math.exp(-s / 0.9)));
    jb = Math.max(jb, DEVOUR_JET * r * clamp((s - 3.2) / 4.5, 0, 1) ** 1.5);
  }
  return { x, y, r, a: sm, phi: ev.phi, srcs, feed, flare, jet: ev.jet, jl, jb, t: age / 1000 };
}
// ---------- the distant capital ship (see "Look", SHIP_*) ----------
// start: the ship's size, its straight, nearly level path across the window at SHIP_DEPTH (eventCam), as the camera is now, from
// the jump point (aj along it from the window's middle, SHIP_JUMP_AT of the way across from the side it comes in by) to just
// clear of the far side (with room for the escort behind it, if it has one); its cruise (v, CSS px a second along it: as fast as
// when it crossed the whole window in SHIP_MS), and ms: the rift's opening plus the time to the far side; the escort's place
// (behind and to one side, in half-lengths) and size; seed: which cells of its rows are lit
let shipForce = null; // tests (__map.ship): whether the escort follows (null: a pick)
registerEvent('ship', {
  start(t) {
    const W = I.skyW || 1, H = I.skyH || 1, rnd = Math.random, cam = eventCam(SHIP_DEPTH), ms = pickIn(SHIP_MS), R = pickIn(SHIP_R);
    const ang = (rnd() * 2 - 1) * SHIP_TILT, sg = rnd() < 0.5 ? -1 : 1, dx = Math.cos(ang) * sg, dy = Math.sin(ang) * sg;
    const escort = shipForce != null ? shipForce : rnd() < SHIP_ESCORT_P;
    const eo = escort ? [-pickIn(SHIP_ESCORT_BACK), (rnd() < 0.5 ? -1 : 1) * pickIn(SHIP_ESCORT_SIDE), pickIn(SHIP_ESCORT_SCALE), rnd()] : null;
    const proj = 0.575 * (Math.abs(W * dx) + Math.abs(H * dy)), rear = (escort ? 2.6 : 1.3) * R, len = 2 * proj + rear + 1.2 * R;
    let off = (rnd() * 2 - 1) * SHIP_OFF * H;
    const edge = 0.5 * (Math.abs(W * dx) + Math.abs(H * dy)), aj = edge * (2 * pickIn(SHIP_JUMP_AT) - 1);
    const v = len / (ms / 1000), a1 = proj + 1.2 * R, run = Math.max(10, (a1 - (aj - SHIP_BOW * R) - SHIP_JUMP_B * R) / v);
    const seed = rnd();
    // a black hole up: often its course is laid to cross the hole's
    const L = evOf('lens');
    if (L && L.ev && (aimForce || rnd() < DEVOUR_AIM_P)) {
      const o = aimAt(cam.mx, cam.my, dx, dy, aj + (SHIP_JUMP_B - SHIP_BOW) * R - (v * SHIP_JUMP_OPEN) / 1000, v, (s) => lensPose(L.ev, t + s * 1000),
        (L.ev.ms - (t - L.ev.at) - DEVOUR_MS[1] - LENS_FADE) / 1000 - 3);
      if (o != null && Math.abs(o) < 0.48 * H) off = o;
    }
    const ev = { at: t, ms: SHIP_JUMP_OPEN + run * 1000, cam, R, dx, dy, x0: cam.mx - dy * off, y0: cam.my + dx * off, aj, v, eo, seed, fall: null };
    // where it would be at `now` on its own course, for the black hole (null while it comes out of the rift)
    ev.free = (now) => { const q = shipPose(ev, now); return q && (!q.j || now - ev.at > SHIP_JUMP_OPEN + 1500) ? q : null; };
    return ev;
  },
  step(ev, t) { return !!ev.fall || t - ev.at < ev.ms; },
});
// the ship as it is now, in CSS px of the window (null when none runs): its middle (x, y), half-length r (with the camera's zoom at its
// depth), alpha a (it fades out over SHIP_FADE at the end of its life; it comes in out of the rift), its heading (cs, sn; unit),
// flip (-1 when it goes left, so its top stays up), the seed, the escort's place and size as laid (eo, or null), and the jump j:
// the rift's middle (x, y) and half-height (h), its alpha (a, 0 once shut), the flash (fl), the hull's smear (sm, in its lengths)
// and the clock (t, s since it began opening). Before the bow breaks out its middle sits SHIP_BOW half-lengths behind the rift
// (all of it is still behind, unseen); after, the lead it came out with (SHIP_JUMP_B half-lengths) runs down to its cruise
const SHIP_BOW = 1.05; // the bow's tip, in half-lengths ahead of the middle
// (all at `now`, ms; shipPose is its own course, shipNow with the black hole's pull: fall, heat 0-1 and the smear sm)
function shipNow() {
  const e = evOf('ship');
  if (!e) return null;
  const ev = e.ev, now = performance.now(), q = shipPose(ev, now);
  if (!ev.fall) return q;
  // caught: off its course into the spiral, its heading turning the way it falls, stretched along it and heating
  const F = ev.fall, b = F.q0, p = fallPose(F, q, now), p1 = fallPose(F, null, now), p2 = fallPose(F, null, now + 80);
  const h0 = Math.atan2(b.sn, b.cs), h = h0 + angDiff(Math.atan2(p2.y - p1.y, p2.x - p1.x), h0) * p.ease;
  return { ...b, x: p.x, y: p.y, r: b.r * p.sc, cs: Math.cos(h), sn: Math.sin(h), j: null, sm: p.st - 1, heat: p.heat, fall: p };
}
function shipPose(ev, now) {
  const age = Math.max(0, now - ev.at), out = (age - SHIP_JUMP_OPEN) / 1000, s = Math.max(0, out);
  const fade = Math.min(1, (ev.ms - age) / SHIP_FADE);
  if (fade <= 0) return null;
  const lead = Math.exp((-s * 1000) / SHIP_JUMP_TAU), al = ev.aj - SHIP_BOW * ev.R + ev.v * s + SHIP_JUMP_B * ev.R * (1 - lead);
  const [x, y] = eventAt(ev.cam, ev.x0 + ev.dx * al, ev.y0 + ev.dy * al);
  const r = ev.R * Math.pow(clamp(I.zoom || 1, ZMIN, ZMAX), SHIP_DEPTH * STAR_ZOOM) / ev.cam.sc;
  // the rift: opening (it grows from a fifth of its height), open while they come out, then folding shut to a sliver
  const sm3 = (v) => { const q = clamp(v, 0, 1); return q * q * (3 - 2 * q); };
  const shut = sm3((age - SHIP_JUMP_OPEN - SHIP_JUMP_HOLD) / SHIP_JUMP_CLOSE), open = sm3(age / SHIP_JUMP_OPEN);
  let j = null;
  if (shut < 1) {
    const [jx, jy] = eventAt(ev.cam, ev.x0 + ev.dx * ev.aj, ev.y0 + ev.dy * ev.aj);
    const grow = 1 - Math.pow(1 - open, 3);
    j = { x: jx, y: jy, h: SHIP_JUMP_R * r * (0.2 + 0.8 * grow) * (1 - 0.8 * shut), a: open * (1 - shut),
      fl: SHIP_JUMP_FLASH * (out < 0 ? sm3((out + 0.3) / 0.3) : Math.exp(-out / 0.32)), sm: out < 0 ? SHIP_JUMP_STREAK : SHIP_JUMP_STREAK * lead, t: age / 1000 };
  }
  return { x, y, r, a: fade * fade * (3 - 2 * fade), cs: ev.dx, sn: ev.dy, flip: ev.dx < 0 ? -1 : 1, seed: ev.seed, eo: ev.eo, j };
}
// ---------- the warp drift (see "Look", WARP_*) ----------
// start: its length, the squeeze's direction and its point, laid in CSS px of the window at WARP_DEPTH (eventCam)
registerEvent('warp', {
  start(t) {
    const W = I.skyW || 1, H = I.skyH || 1, rnd = Math.random, cam = eventCam(WARP_DEPTH);
    const ang = Math.atan2(STAR_DIR[1], STAR_DIR[0]) + (rnd() * 2 - 1) * WARP_TURN;
    return { at: t, ms: pickIn(WARP_MS), cam, dx: Math.cos(ang), dy: Math.sin(ang), x: cam.mx + (pickIn(WARP_AT) - 0.5) * W, y: cam.my + (pickIn(WARP_AT) - 0.5) * H };
  },
  step(ev, t) { return t - ev.at < ev.ms; },
});
// the warp as it is now (null when none runs): the stretch share a (0-1, eased in and out), its point (x, y, CSS px of the window,
// with the camera) and direction (dx, dy; unit)
function warpNow() {
  const e = evOf('warp');
  if (!e) return null;
  const ev = e.ev, f = clamp((performance.now() - ev.at) / ev.ms, 0, 1);
  const a = clamp(f / WARP_IN, 0, 1) * clamp((1 - f) / WARP_OUT, 0, 1);
  if (a <= 0) return null;
  const [x, y] = eventAt(ev.cam, ev.x, ev.y);
  return { a: a * a * (3 - 2 * a), x, y, dx: ev.dx, dy: ev.dy };
}
// ---------- one sky: aiming one event at another, and the black hole's pull (see "Look", DEVOUR_*) ----------
const sm01 = (v) => { const q = clamp(v, 0, 1); return q * q * (3 - 2 * q); };
const angDiff = (a, b) => ((((a - b) % TAU) + 3 * Math.PI) % TAU) - Math.PI; // a - b, within -pi..pi
let aimForce = false; // tests (__map.devour): always aim
// the offset across a straight path (through the window's middle mx, my along the unit dx, dy; its mover at a0 + v s along it,
// s seconds from now) that meets a target whose place s seconds from now is at(s) ({ x, y } or null), within sMax s; null: none
// (the meeting in view: AIM_IN of the window's width and height in from its edges; tried from a few first guesses)
const AIM_IN = [0.14, 0.18], AIM_TRY = [0.4, 0.25, 0.55, 0.7, 0.15, 0.85];
function aimAt(mx, my, dx, dy, a0, v, at, sMax) {
  if (!(sMax > 4) || !(v > 0)) return null;
  const W = I.skyW || 1, H = I.skyH || 1;
  next: for (const s0 of AIM_TRY) {
    let s = sMax * s0, off = null, P = null;
    for (let i = 0; i < 6; i++) {
      P = at(s);
      if (!P) continue next;
      const rx = P.x - mx, ry = P.y - my;
      off = -rx * dy + ry * dx;
      s = (rx * dx + ry * dy - a0) / v;
      if (!(s > 3) || s > sMax) continue next;
    }
    P = at(s);
    if (P && P.x > AIM_IN[0] * W && P.x < (1 - AIM_IN[0]) * W && P.y > AIM_IN[1] * H && P.y < (1 - AIM_IN[1]) * H) return off;
  }
  return null;
}
// where prey caught at F (devourStep) is at `now` (ms): spiralling in round the hole (F.hx, hy, hr: the hole's last place and
// Einstein radius, or where it is now), off its own place q (null: none) over the first DEVOUR_EASE of its fall; f its share
// of the fall, ease how far off its course it is, th and rho its angle and distance from the hole, sc its size share, st
// its stretch and heat (0-1)
function fallPose(F, q, now) {
  const L = evOf('lens'), lp = L ? lensPose(L.ev, now) : null;
  const hx = lp ? lp.x : F.hx, hy = lp ? lp.y : F.hy, hr = lp ? lp.r : F.hr;
  const f = clamp((now - F.at) / F.ms, 0, 1), g = Math.pow(f, 1.6);
  const rho = F.d0 + (hr * LENS_RING_R - F.d0) * g, th = F.a0 + F.w * TAU * DEVOUR_TURNS * Math.pow(f, 1.35);
  let x = hx + rho * Math.cos(th), y = hy + rho * Math.sin(th);
  const ease = sm01(f / DEVOUR_EASE);
  if (q) { x = q.x + (x - q.x) * ease; y = q.y + (y - q.y) * ease; }
  return { x, y, f, ease, th, rho, hx, hy, sc: 1 - 0.94 * Math.pow(f, 1.7), st: 1 + DEVOUR_STRETCH * f * f, heat: sm01((f - 0.12) / 0.75) };
}
// each frame: the lens (when it is up, whole, and has time left for a fall) catches the prey that comes within DEVOUR_REACH;
// a prey falling follows the hole and, at the end of its fall, is gone into it (the lens remembers the meal: its flare)
function devourStep() {
  const L = evOf('lens'), now = performance.now(), lp = L ? lensPose(L.ev, now) : null;
  for (const k of PREY) {
    const e = evOf(k);
    if (!e || !e.ev) continue;
    const F = e.ev.fall;
    if (F) {
      if (lp) { F.hx = lp.x; F.hy = lp.y; F.hr = lp.r; }
      if (now - F.at >= F.ms) {
        if (L) L.ev.fed.push({ at: F.at + F.ms, k });
        eventEnd(k);
      }
      continue;
    }
    if (!lp || lp.sm < 0.98 || I.skyOff.has('devour') || L.ev.ms - (now - L.ev.at) < DEVOUR_MS[1] + LENS_FADE + 1500) continue;
    const q = e.ev.free(now);
    if (!q) continue;
    const dx = q.x - lp.x, dy = q.y - lp.y, d = Math.hypot(dx, dy);
    if (d > DEVOUR_REACH * lp.r + 0.5 * q.r) continue;
    // it winds round the way its own motion carries it past the hole
    const q2 = e.ev.free(now + 1000) || q, cr = dx * (q2.y - q.y) - dy * (q2.x - q.x);
    e.ev.fall = { at: now, ms: pickIn(DEVOUR_MS), d0: d, a0: Math.atan2(dy, dx), w: cr >= 0 ? 1 : -1, hx: lp.x, hy: lp.y, hr: lp.r, q0: q };
    I.dirty = true;
    skyLog('devour', k === 'ship' ? 'Black hole swallows the capital ship' : 'Black hole swallows a planet', null, e.ev.fall.ms, q.x, q.y);
  }
}
// ---------- the planet (see "Look", PLANET_*) ----------
// start: its kind, size, rings and moon, its star's direction, its axis and spin, and its straight path across the window at
// PLANET_DEPTH (eventCam), from just off one side to just off the other, as the camera is now (often aimed at a black hole up)
let planetForce = null; // tests (__map.planet): its kind (null: a pick)
registerEvent('planet', {
  start(t) {
    const W = I.skyW || 1, H = I.skyH || 1, rnd = Math.random, cam = eventCam(PLANET_DEPTH), ms = pickIn(PLANET_MS);
    const pk = Math.floor(rnd() * PLANET_KINDS.length), kind = planetForce != null ? planetForce : pk;
    const R = pickIn(PLANET_R) * [1.12, 0.9, 1, 0.95, 0.74][kind];
    const ang = (rnd() * 2 - 1) * PLANET_TURN, sg = rnd() < 0.5 ? -1 : 1, dx = Math.cos(ang) * sg, dy = Math.sin(ang) * sg;
    const ring = (kind === 0 || kind === 2) && rnd() < PLANET_RING_P ? { in: pickIn(PLANET_RING.in), out: pickIn(PLANET_RING.out) } : null;
    const open = pickIn(PLANET_RING.open) * (rnd() < 0.5 ? -1 : 1);
    const moon = rnd() < PLANET_MOON_P ? { r: pickIn(PLANET_MOON.r), d: pickIn(PLANET_MOON.d) * (ring ? 1.2 : 1),
      w: (TAU / pickIn(PLANET_MOON.per)) * (rnd() < 0.5 ? -1 : 1), ph: rnd() * TAU } : null;
    const reach = R * Math.max(1 + 4 * PLANET_KINDS[kind][3], ring ? ring.out : 1, moon ? moon.d + moon.r : 1) + 6;
    const len = 2 * (0.575 * (Math.abs(W * dx) + Math.abs(H * dy)) + reach), v = len / (ms / 1000);
    const back = rnd() < PLANET_BACK_P, lz = back ? pickIn(PLANET_BACK) : pickIn(PLANET_LIT);
    const la = -Math.PI / 2 + (rnd() * 2 - 1) * 1.9, lc = Math.sqrt(1 - lz * lz);
    const ev = { at: t, ms, cam, R, dx, dy, off: (rnd() * 2 - 1) * PLANET_OFF * H, len, v, kind, reach, ring, open, moon,
      tilt: (rnd() * 2 - 1) * PLANET_TILT, spin: pickIn(PLANET_SPIN) * (rnd() < 0.5 ? -1 : 1), ph: rnd() * TAU, seed: rnd(),
      light: [Math.cos(la) * lc, Math.sin(la) * lc, lz], fall: null };
    const L = evOf('lens');
    if (L && L.ev && (aimForce || rnd() < DEVOUR_AIM_P)) {
      const o = aimAt(cam.mx, cam.my, dx, dy, -len / 2, v, (s) => lensPose(L.ev, t + s * 1000), (L.ev.ms - (t - L.ev.at) - DEVOUR_MS[1] - LENS_FADE) / 1000 - 3);
      if (o != null && Math.abs(o) < 0.48 * H) ev.off = o;
    }
    ev.free = (now) => planetPose(ev, now);
    return ev;
  },
  step(ev, t) { return !!ev.fall || t - ev.at < ev.ms; },
});
// the planet on its own path at `now` (ms), in CSS px of the window (null outside its life, unless any): its middle (x, y),
// radius r, its turn (spin, radians) and its moon's place round it (x, y across and up its axis's roll, in its radii; z > 0
// in front of it) and size, or null
function planetPose(ev, now, any) {
  const age = now - ev.at;
  if (!any && (age < 0 || age > ev.ms)) return null;
  const s = age / 1000, al = -ev.len / 2 + ev.v * s;
  const [x, y] = eventAt(ev.cam, ev.cam.mx + ev.dx * al - ev.dy * ev.off, ev.cam.my + ev.dy * al + ev.dx * ev.off);
  const k = Math.pow(clamp(I.zoom || 1, ZMIN, ZMAX), PLANET_DEPTH * STAR_ZOOM) / ev.cam.sc;
  let moon = null;
  if (ev.moon) {
    // its orbit lies in the planet's equator, seen from `open` over it
    const m = ev.moon, ph = m.ph + m.w * s, c = Math.cos(ph), sn = Math.sin(ph);
    moon = { x: m.d * c, y: m.d * sn * ev.open, z: m.d * sn, r: m.r };
  }
  return { x, y, r: ev.R * k, spin: ev.ph + ev.spin * s, moon };
}
// the planet as it is now (null when none runs): planetPose's, its kind, rings, view over its equator (open), axis's roll
// (tilt), star (light: x, y on the screen, z towards us) and seed; caught by the black hole, its place on the fall, size
// shrinking, tide (the unit way to the hole), stretch st and heat (0-1), and fall (fallPose's)
function planetNow() {
  const e = evOf('planet');
  if (!e) return null;
  const ev = e.ev, now = performance.now();
  let q = planetPose(ev, now);
  if (ev.fall) {
    const p = fallPose(ev.fall, q, now), b = planetPose(ev, now, true), tx = p.hx - p.x, ty = p.hy - p.y, tl = Math.hypot(tx, ty) || 1;
    q = { ...b, x: p.x, y: p.y, r: b.r * p.sc, tide: [tx / tl, ty / tl], st: p.st, heat: p.heat, fall: p };
  }
  return q && { ...q, kind: ev.kind, ring: ev.ring, open: ev.open, tilt: ev.tilt, light: ev.light, seed: ev.seed };
}
// ---------- the space battle (see "Look", BATTLE_*) ----------
// a hull's turrets (where its bolts leave) and its hangar (where its fighters come and go), in its half-lengths (SHIP_BOXES)
const BT_TURRETS = [[0.25, -0.112], [0.33, -0.098], [-0.2, -0.157], [0.06, -0.16], [-0.56, -0.165]], BT_HANGAR = [-0.12, 0.15];
// start: where it happens (farPlace: clear of the orbs and hubs), its line, the two sides' ships (when each comes out of its
// rift, its course and lane), who loses and when (it starts to blow up at sKill, breaks at sBreak, its halves' last bursts at
// ends), when the rest leave, and the fighters' pairs; everything after is battleStep's, by the battle's clock (s)
registerEvent('battle', {
  start(t) {
    const W = I.skyW || 1, H = I.skyH || 1, rnd = Math.random, cam = eventCam(BATTLE_DEPTH);
    const R = pickIn(BATTLE_R), gap = pickIn(BATTLE_GAP) * R, X = pickIn(BATTLE_X) * R;
    const at = farPlace(Math.min(X + gap, Math.min(W, H) / 4)) || [W * pickIn(BATTLE_AT), H * pickIn(BATTLE_AT)];
    const ang = (rnd() * 2 - 1) * BATTLE_TILT, dx = Math.cos(ang), dy = Math.sin(ang);
    const life = pickIn(BATTLE_MS) / 1000, sKill = life * pickIn(BATTLE_KILL), sBreak = sKill + BATTLE_BREAK / 1000;
    const loser = rnd() < 0.5 ? 0 : 1, escSide = rnd() < 0.8 ? (rnd() < 0.5 ? 0 : 1) : -1, first = rnd() < 0.5 ? 0 : 1;
    const ships = [];
    let s = 0.3;
    for (const side of [first, 1 - first]) {
      // side 0 goes along the line, side 1 back; each in its lane, its middle at along a(s) = aOut + sg v (s - sOut)
      const sg = side === 0 ? 1 : -1, v = pickIn(BATTLE_V), lane = (side === 0 ? -1 : 1) * gap / 2;
      const add = (scale, back, across) => {
        ships.push({ side, sg, v, R: R * scale, aOut: -sg * (X + back * R), c: lane + Math.sign(lane) * across * R, sOut: s + SHIP_JUMP_OPEN / 1000,
          seed: rnd(), esc: scale < 1, sLeave: Infinity, halves: null, next: 0 });
        s += pickIn(BATTLE_ARRIVE) / 1000;
      };
      add(1, 0, 0);
      if (escSide === side) add(pickIn(BATTLE_ESCORT), 1.9, 0.45);
      s += (pickIn(BATTLE_ARRIVE) / 1000) * 0.8;
    }
    const lose = ships.findIndex((q) => q.side === loser && !q.esc);
    let k = 0;
    // the loser's escort flees soon after; the winners leave once it is over
    ships.forEach((q, i) => { if (i !== lose) q.sLeave = q.side === loser ? sBreak + 2.6 : sBreak + BATTLE_LEAVE / 1000 + 1.3 * k++; });
    const ends = [sBreak + pickIn([10, 14]), sBreak + pickIn([14, 18])];
    const end = Math.max(...ships.map((q) => (q.sLeave === Infinity ? 0 : q.sLeave + 4.6)), ends[1] + 6.6);
    const fire0 = Math.max(...ships.map((q) => q.sOut)) + 2.2, pairs = [];
    for (let i = Math.floor(pickIn([BATTLE_FIGHTERS[0], BATTLE_FIGHTERS[1] + 1])); i > 0; i--) {
      pairs.push({ q: rnd() < 0.5 ? 0 : 1, ax: pickIn([1.4, 2.6]) * R, ay: pickIn([0.25, 0.42]) * gap, ox: pickIn([-0.6, 0.6]) * R,
        w1: pickIn([0.32, 0.5]) * (rnd() < 0.5 ? -1 : 1), k2: rnd() < 0.5 ? 2 : 1.5, p1: rnd() * TAU, p2: rnd() * TAU,
        launch: [fire0 - 1 + rnd() * 3, fire0 + rnd() * 3], down: [rnd() < BATTLE_DOWN ? pickIn([fire0 + 8, sKill]) : null, null], popped: [false, false],
        next: fire0 + rnd() * 2 });
    }
    return { at: t, ms: end * 1000, cam, x: at[0], y: at[1], dx, dy, R, gap, ships, lose, loser, sKill, sBreak, ends, fire0, pairs,
      shots: [], blasts: [], torpAt: [fire0 + pickIn([2, 6]), fire0 + pickIn([4, 9])], killed: false };
  },
  step(ev, t) { battleStep(ev, (t - ev.at) / 1000); return t - ev.at < ev.ms; },
});
// ship i of the battle at s (its clock, s): the hulls to draw (none before its rift opens or once gone, two once broken), laid
// in CSS px of the window as the camera was at the start; each { x, y, r, a, cs, sn, flip, seed, j (its rift: x, y, h, a, fl,
// cut (1: the hull shows ahead of it, -1: behind), t; or null), sm (its smear), side, half (0 whole, 1 the bow's, -1 the
// stern's), cut (where it broke, in its half-lengths) and heat (0-1) }
function btHull(ev, i, s) {
  const q = ev.ships[i], hx = q.sg * ev.dx, hy = q.sg * ev.dy, nx = -ev.dy, ny = ev.dx;
  const at = (a) => [ev.x + ev.dx * a + nx * q.c, ev.y + ev.dy * a + ny * q.c];
  const base = { r: q.R, a: 1, cs: hx, sn: hy, flip: hx < 0 ? -1 : 1, seed: q.seed, j: null, sm: 0, side: q.side, half: 0, cut: 0, heat: 0 };
  const open = s - (q.sOut - SHIP_JUMP_OPEN / 1000);
  if (open < 0) return [];
  // broken: two halves tumbling apart about the break, each until its last burst
  if (q.halves) {
    return q.halves.filter((h) => s < h.end).map((h) => {
      const u = s - ev.sBreak, th = h.w * u, c = Math.cos(th), sn = Math.sin(th);
      const ox = h.ox * c - h.oy * sn, oy = h.ox * sn + h.oy * c;
      return { ...base, x: h.px + h.vx * u + ox, y: h.py + h.vy * u + oy, cs: hx * c - hy * sn, sn: hx * sn + hy * c, half: h.h, cut: h.cut,
        heat: 0.9 * Math.max(0.35, 1 - u / 9) };
    });
  }
  // out of its rift as the capital ship comes (shipPose): from behind it, ahead of its cruise, slowing to it
  const ms = open * 1000, out = (ms - SHIP_JUMP_OPEN) / 1000, ss = Math.max(0, out), lead = Math.exp((-ss * 1000) / SHIP_JUMP_TAU);
  const cruise = q.aOut + q.sg * q.v * (s - q.sOut);
  let al = q.aOut + q.sg * q.v * ss - q.sg * SHIP_JUMP_B * q.R * lead, j = null, sm = 0;
  const shut = sm01((ms - SHIP_JUMP_OPEN - SHIP_JUMP_HOLD) / SHIP_JUMP_CLOSE), op = sm01(ms / SHIP_JUMP_OPEN);
  if (shut < 1) {
    const [jx, jy] = at(q.aOut + q.sg * (SHIP_BOW - SHIP_JUMP_B) * q.R), grow = 1 - Math.pow(1 - op, 3);
    j = { x: jx, y: jy, h: SHIP_JUMP_R * q.R * (0.2 + 0.8 * grow) * (1 - 0.8 * shut), a: op * (1 - shut), cut: 1,
      fl: SHIP_JUMP_FLASH * (out < 0 ? sm01((out + 0.3) / 0.3) : Math.exp(-out / 0.32)), t: open };
    sm = out < 0 ? SHIP_JUMP_STREAK : SHIP_JUMP_STREAK * lead;
  }
  // leaving: a rift opens ahead, it leaps in, smeared back, and is gone past it as the rift folds shut
  if (s >= q.sLeave) {
    const go = q.sLeave + SHIP_JUMP_OPEN / 1000, u = s - go, aGo = q.aOut + q.sg * q.v * (go - q.sOut);
    const op2 = sm01(((s - q.sLeave) * 1000) / SHIP_JUMP_OPEN), shut2 = sm01(((u - 0.8) * 1000) / SHIP_JUMP_CLOSE);
    if (shut2 >= 1) return [];
    al = u > 0 ? aGo + q.sg * (q.v * u + 7 * q.R * (u / 0.55) ** 2) : cruise;
    sm = SHIP_JUMP_STREAK * sm01(u / 0.3);
    const [jx, jy] = at(aGo + q.sg * (SHIP_BOW + 0.35) * q.R);
    j = { x: jx, y: jy, h: SHIP_JUMP_R * q.R * (0.2 + 0.8 * (1 - Math.pow(1 - op2, 3))) * (1 - 0.8 * shut2), a: op2 * (1 - shut2), cut: -1,
      fl: SHIP_JUMP_FLASH * (u < 0 ? sm01((u + 0.3) / 0.3) : Math.exp(-u / 0.32)), t: s - q.sLeave };
  }
  const [x, y] = at(al);
  return [{ ...base, x, y, j, sm, heat: i === ev.lose ? 0.85 * sm01((s - ev.sKill) / (BATTLE_BREAK / 1000)) : 0 }];
}
// the point (ux along, uy across, in its half-lengths) on ship i's hull at s, laid as btHull's; null when that part of it is
// not there (not out yet, gone, or a half already burst)
function btPoint(ev, i, ux, uy, s) {
  const hs = btHull(ev, i, s);
  const h = hs.find((q) => !q.half || q.half * (ux - q.cut) > 0);
  if (!h) return null;
  return [h.x + h.r * (ux * h.cs - uy * h.flip * h.sn), h.y + h.r * (ux * h.sn + uy * h.flip * h.cs)];
}
// how much of a bolt ship i's shield turns away at s (0-1): the loser's fails as the fight goes on
function btShield(ev, i, s) {
  const q = ev.ships[i];
  if (i === ev.lose) return 0.85 * clamp(1 - (s - ev.fire0) / Math.max(4, ev.sKill - ev.fire0 - 4), 0, 1);
  return q.esc ? 0.45 : 0.7;
}
// fighter who (0 the quarry, 1 its chaser) of pair p at s, laid: { x, y, f (how far out of its hangar, 0-1), side }, or null
// while it is docked, before it launches or once it is shot down
function btFighter(ev, p, who, s) {
  const side = who ? 1 - p.q : p.q, home = ev.ships.findIndex((q) => q.side === side && !q.esc), t0 = p.launch[who], dn = p.down[who];
  if (s < t0 || (dn != null && s >= dn)) return null;
  const ts = s - (who ? BATTLE_CHASE : 0), px = p.ox + p.ax * Math.sin(p.w1 * ts + p.p1), py = p.ay * Math.sin(p.k2 * p.w1 * ts + p.p2);
  let x = ev.x + ev.dx * px - ev.dy * py, y = ev.y + ev.dy * px + ev.dx * py, f = 1;
  const hg = home >= 0 ? btPoint(ev, home, BT_HANGAR[0], BT_HANGAR[1], s) : null;
  if (hg) {
    // out of its hangar over 3 s, and home again before its ship jumps away
    const fr = sm01((s - (ev.ships[home].sLeave - 5.5)) / 3);
    if (fr >= 1) return null;
    f = Math.min(sm01((s - t0) / 3), 1 - fr);
    x = hg[0] + (x - hg[0]) * f; y = hg[1] + (y - hg[1]) * f;
  } else if (s < t0 + 3) return null;
  return { x, y, f, side };
}
// each frame of the battle (s: its clock, s): the volleys, torpedoes and tracers fired, what they hit, the loser's end, the
// fighters shot down; shots and blasts are kept with their own clocks (t0, s) and laid on the hulls (att) where they hit
function battleStep(ev, s) {
  const rnd = Math.random, R = ev.R;
  const alive = (i) => { const q = ev.ships[i]; return s >= q.sOut + 0.6 && s < q.sLeave && !q.halves; };
  const foes = (side) => ev.ships.map((q, i) => i).filter((i) => ev.ships[i].side !== side && alive(i));
  const blast = (o) => ev.blasts.push({ t0: s, seed: rnd(), side: 0, ...o });
  if (s > ev.fire0 && s < ev.sBreak + 1.5) {
    // volleys: each ship every BATTLE_FIRE, at the other side's capital (now and then its escort)
    ev.ships.forEach((q, i) => {
      if (!alive(i) || s < q.next) return;
      const first = !q.next;
      q.next = s + ((pickIn(BATTLE_FIRE) / 1000) * (q.esc ? 1.4 : 1)) * (first ? rnd() : 1);
      const fs = foes(q.side);
      if (first || !fs.length || ev.shots.filter((o) => o.type === 0).length > 9) return;
      const cap = fs.find((k) => !ev.ships[k].esc), esc = fs.find((k) => ev.ships[k].esc);
      const to = esc != null && (cap == null || rnd() < 0.3) ? esc : cap;
      const tu = BT_TURRETS[Math.floor(rnd() * BT_TURRETS.length)];
      for (let k = 0, n = Math.round(pickIn(BATTLE_VOLLEY) * (q.esc ? 0.6 : 1)); k < n; k++) {
        ev.shots.push({ type: 0, side: q.side, from: i, fu: k % 2 ? BT_TURRETS[Math.floor(rnd() * BT_TURRETS.length)] : tu, t0: s + k * pickIn([0.08, 0.16]),
          to, tu: [pickIn([-0.75, 0.8]), pickIn([-0.09, 0.1])], src: null, T: 0 });
      }
    });
    // torpedoes: one side's capital at a ship of the other's, curving across; point defence may stop it halfway
    for (const side of [0, 1]) {
      if (s < ev.torpAt[side]) continue;
      ev.torpAt[side] = s + pickIn(BATTLE_TORP) / 1000;
      const from = ev.ships.findIndex((q, i) => q.side === side && !q.esc && alive(i)), fs = foes(side);
      if (from < 0 || !fs.length) continue;
      ev.shots.push({ type: 2, side, from, fu: [0.85, 0.05], t0: s, to: fs[Math.floor(rnd() * fs.length)], tu: [pickIn([-0.5, 0.5]), 0], src: null, T: 0,
        bend: (rnd() < 0.5 ? -1 : 1) * pickIn([0.8, 1.6]) * R, stop: rnd() < BATTLE_PD ? pickIn([0.45, 0.72]) : null });
    }
  }
  // tracers: each chaser at its quarry, where it will be
  for (const p of ev.pairs) {
    if (s < p.next) continue;
    p.next = s + pickIn(BATTLE_TRACER) / 1000;
    const a = btFighter(ev, p, 1, s), b = btFighter(ev, p, 0, s + 0.12);
    if (a && b && a.f >= 1 && b.f >= 1) ev.shots.push({ type: 3, side: a.side, t0: s, src: [a.x, a.y], dst: [b.x, b.y], T: Math.hypot(b.x - a.x, b.y - a.y) / 300, fix: true });
  }
  // the shots in flight: laid from where they left, at where they are going, landing on a shield or the hull
  for (const o of ev.shots) {
    if (s < o.t0 || o.done) continue;
    if (!o.src) {
      o.src = btPoint(ev, o.from, o.fu[0], o.fu[1], o.t0);
      const d = o.src && btPoint(ev, o.to, o.tu[0], o.tu[1], s);
      if (!d) { o.done = true; continue; }
      o.T = Math.hypot(d[0] - o.src[0], d[1] - o.src[1]) / (o.type === 2 ? BATTLE_TORP_V : BATTLE_BOLT[1]);
    }
    const f = (s - o.t0) / Math.max(o.T, 0.05);
    if (o.type === 2 && o.stop != null && f >= o.stop) {
      o.done = true;
      const pt = btShotAt(ev, o, s);
      if (pt) blast({ kind: 5, life: 0.6, x: pt[0], y: pt[1], r: 0.16 * R, side: 1 - o.side });
      continue;
    }
    if (f < 1) continue;
    o.done = true;
    if (o.fix) continue;
    const tq = ev.ships[o.to], d = btPoint(ev, o.to, o.tu[0], o.tu[1], s);
    if (!d) continue;
    if (rnd() < btShield(ev, o.to, s)) {
      // on the shield: a ripple a little off the hull, towards the shot
      const ux = o.src[0] - d[0], uy = o.src[1] - d[1], ul = Math.hypot(ux, uy) || 1;
      blast({ kind: 1, life: 0.7, x: d[0] + (ux / ul) * 0.2 * tq.R, y: d[1] + (uy / ul) * 0.2 * tq.R, r: (o.type === 2 ? 1.7 : 1) * 0.3 * tq.R, side: tq.side });
    } else {
      blast({ kind: o.type === 2 ? 2 : 0, life: o.type === 2 ? 1.8 : 0.45, att: [o.to, ...o.tu], r: (o.type === 2 ? 0.26 : 0.14) * tq.R, side: o.side });
      if (o.to === ev.lose && ev.blasts.filter((b) => b.kind === 4).length < 4 && rnd() < 0.3) blast({ kind: 4, life: Infinity, att: [o.to, ...o.tu], r: 0.1 * tq.R });
    }
  }
  ev.shots = ev.shots.filter((o) => !o.done);
  // the loser's end: explosions run along its hull, fires take, then it breaks in two
  if (!ev.killed && s >= ev.sKill) {
    ev.killed = true;
    for (let k = 0; k < 6; k++) {
      ev.blasts.push({ kind: 2, t0: ev.sKill + (k / 6) * (BATTLE_BREAK / 1000) * pickIn([0.85, 1.1]), life: 1.8, att: [ev.lose, pickIn([-0.8, 0.85]), pickIn([-0.1, 0.1])],
        r: pickIn([0.2, 0.34]) * R, seed: rnd(), side: 1 - ev.loser });
    }
    for (let k = 0; k < 2; k++) blast({ kind: 4, life: Infinity, att: [ev.lose, pickIn([-0.7, 0.7]), pickIn([-0.08, 0.08])], r: 0.12 * R });
  }
  const lq = ev.ships[ev.lose];
  if (!lq.halves && s >= ev.sBreak) {
    const [h] = btHull(ev, ev.lose, ev.sBreak);
    if (h) {
      const cut = pickIn([-0.25, 0.25]), px = h.x + h.cs * cut * h.r, py = h.y + h.sn * cut * h.r;
      lq.halves = [1, -1].map((hh, k) => {
        const sp = pickIn([0.05, 0.09]) * R, sd = (rnd() < 0.5 ? -1 : 1) * 0.4 * sp;
        return { h: hh, cut, end: ev.ends[k], px, py, ox: h.x - px, oy: h.y - py, w: hh * pickIn([0.02, 0.05]) * (rnd() < 0.5 ? -1 : 1),
          vx: lq.sg * lq.v * ev.dx + hh * sp * h.cs - sd * h.sn, vy: lq.sg * lq.v * ev.dy + hh * sp * h.sn + sd * h.cs };
      });
      blast({ kind: 3, life: 6.5, x: h.x, y: h.y, r: 0.9 * h.r, side: 1 - ev.loser, t0: ev.sBreak });
      // its fighters are lost with it
      for (const p of ev.pairs) {
        const w = p.q === ev.loser ? 0 : 1;
        p.down[w] = Math.min(p.down[w] == null ? Infinity : p.down[w], s + pickIn([0.6, 5]));
      }
    } else lq.halves = [];
  }
  // each half's last burst
  for (const h of lq.halves || []) {
    if (h.burst || s < h.end - 0.05) continue;
    h.burst = true;
    const pt = btHull(ev, ev.lose, h.end - 0.06).find((q) => q.half === h.h);
    if (pt) blast({ kind: 7, life: 6, x: pt.x, y: pt.y, r: 0.6 * R, side: 1 - ev.loser, t0: h.end });
  }
  // fighters shot down: a small burst where it was
  for (const p of ev.pairs) {
    for (const w of [0, 1]) {
      if (p.popped[w] || p.down[w] == null || s < p.down[w]) continue;
      p.popped[w] = true;
      const f = btFighter(ev, { ...p, down: [null, null] }, w, p.down[w]);
      if (f) blast({ kind: 6, life: 0.9, x: f.x, y: f.y, r: 0.12 * R, side: 1 - f.side });
    }
  }
  ev.blasts = ev.blasts.filter((b) => s < b.t0 + b.life && !(b.att && b.t0 < s - 0.5 && !btPoint(ev, b.att[0], b.att[1], b.att[2], s)));
}
// where shot o is at s, laid (null before it leaves): a bolt or tracer straight on, a torpedo on its curve
function btShotAt(ev, o, s, back = 0) {
  if (!o.src) return null;
  const dst = o.fix ? o.dst : btPoint(ev, o.to, o.tu[0], o.tu[1], s);
  if (!dst) return null;
  const f = clamp((s - o.t0) / Math.max(o.T, 0.05) - back, 0, 1), [ax, ay] = o.src, [bx, by] = dst;
  if (o.type !== 2) return [ax + (bx - ax) * f, ay + (by - ay) * f];
  const l = Math.hypot(bx - ax, by - ay) || 1, cx = (ax + bx) / 2 - ((by - ay) / l) * o.bend, cy = (ay + by) / 2 + ((bx - ax) / l) * o.bend, g = 1 - f;
  return [g * g * ax + 2 * g * f * cx + f * f * bx, g * g * ay + 2 * g * f * cy + f * f * by];
}
// the battle as it is now, in CSS px of the window (null when none runs): its middle (x, y) and reach (CSS px: all of it lies
// within), and what the shader draws: hulls (btHull's, at most BATTLE_HULLS), streaks (fighters first, then torpedoes, bolts
// and tracers: head hx, hy, tail tx, ty, rgb, a, type: 0 a bolt, 1 a fighter, 2 a torpedo, 3 a tracer; at most
// BATTLE_STREAKS) and blasts (the big ones first: x, y, r, a, age (s), seed, kind, side; at most BATTLE_BLASTS)
function battleNow() {
  const e = evOf('battle');
  if (!e) return null;
  const ev = e.ev, s = Math.max(0, performance.now() - ev.at) / 1000, k = Math.pow(clamp(I.zoom || 1, ZMIN, ZMAX), BATTLE_DEPTH * STAR_ZOOM) / ev.cam.sc;
  const P = (x, y) => eventAt(ev.cam, x, y), white = (c, w) => c.map((v) => v + (1 - v) * w);
  const [cx, cy] = P(ev.x, ev.y);
  let reach = 0;
  const grow = (x, y, r) => { reach = Math.max(reach, Math.hypot(x - cx, y - cy) + r); };
  const hulls = [];
  ev.ships.forEach((q, i) => {
    for (const h of btHull(ev, i, s)) {
      const [x, y] = P(h.x, h.y), j = h.j ? { ...h.j, ...(([jx, jy]) => ({ x: jx, y: jy, h: h.j.h * k }))(P(h.j.x, h.j.y)) } : null;
      hulls.push({ ...h, x, y, r: h.r * k, j });
      grow(x, y, h.r * k * 1.8 * (1 + h.sm));
      if (j) grow(j.x, j.y, 4 * j.h);
    }
  });
  const streaks = [];
  for (const p of ev.pairs) {
    for (const w of [0, 1]) {
      const a = btFighter(ev, p, w, s);
      if (!a) continue;
      const b = btFighter(ev, p, w, s - 0.3) || a, [hx, hy] = P(a.x, a.y), [tx, ty] = P(b.x, b.y);
      streaks.push({ hx, hy, tx, ty, rgb: white(BATTLE_SIDES[a.side], 0.15), a: 0.75 * (0.35 + 0.65 * a.f), type: 1 });
    }
  }
  for (const type of [2, 0, 3]) {
    for (const o of ev.shots) {
      if (o.type !== type || s < o.t0 || !o.src) continue;
      const len = type === 2 ? 0.22 : (type === 3 ? 6 : BATTLE_BOLT[0]) / Math.max(1, (o.T || 0.05) * (type === 3 ? 300 : BATTLE_BOLT[1]));
      const h = btShotAt(ev, o, s), t = btShotAt(ev, o, s, len);
      if (!h || !t) continue;
      const [hx, hy] = P(h[0], h[1]), [tx, ty] = P(t[0], t[1]);
      streaks.push({ hx, hy, tx, ty, rgb: type === 2 ? [1, 0.86, 0.62] : white(BATTLE_SIDES[o.side], 0.2), a: type === 0 ? 0.8 : type === 2 ? 0.8 : 0.5, type });
    }
  }
  const order = { 3: 0, 7: 0, 2: 1, 6: 2, 4: 3, 0: 4, 1: 4, 5: 4 }, blasts = [];
  for (const b of ev.blasts) {
    const age = s - b.t0;
    if (age < 0 || age > b.life) continue;
    const pt = b.att ? btPoint(ev, b.att[0], b.att[1], b.att[2], s) : [b.x, b.y];
    if (!pt) continue;
    const [x, y] = P(pt[0], pt[1]);
    blasts.push({ x, y, r: b.r * k, a: b.kind === 4 ? Math.min(1, age / 0.6) : 1, age, seed: b.seed, kind: b.kind, side: b.side });
  }
  blasts.sort((a, b) => order[a.kind] - order[b.kind]);
  const out = { x: cx, y: cy, hulls: hulls.slice(0, BATTLE_HULLS), streaks: streaks.slice(0, BATTLE_STREAKS), blasts: blasts.slice(0, BATTLE_BLASTS), s };
  for (const q of out.streaks) { grow(q.hx, q.hy, 8); grow(q.tx, q.ty, 8); }
  for (const b of out.blasts) grow(b.x, b.y, b.r * (b.kind === 3 ? 7 : 4.5) + 8);
  out.reach = reach;
  return out;
}
// ---------- the far events (see "Look", FAR_*; the catalog is web/sky-far.js) ----------
// the log (POST /sky-events, sky-events.js on the server): one line per event that starts, so "what was that at 3:42?"
// has an answer; where: the window's third it is in. Never throws (the fixture page has no server)
function skyLog(kind, label, what, ms, x, y) {
  const W = I.skyW || 1, H = I.skyH || 1;
  const where = x == null ? 'across the sky' : `${y < H / 3 ? 'upper' : y > (2 * H) / 3 ? 'lower' : 'middle'} ${x < W / 3 ? 'left' : x > (2 * W) / 3 ? 'right' : 'centre'}`;
  const body = { shown: { kind, label, what: what || null, ms: Math.round(ms || 0), where, x: x == null ? null : Math.round(x), y: y == null ? null : Math.round(y), w: Math.round(W), h: Math.round(H) } };
  try { fetch('/sky-events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {}); } catch { /* no server */ }
}
// the kinds switched off (GET /sky-events: { off: [names] }), read when the map starts and every SKY_OFF_MS
function skyOffRead(t) {
  I.skyOffAt = t + SKY_OFF_MS;
  try {
    fetch('/sky-events').then((r) => (r.ok ? r.json() : null)).then((j) => {
      if (I && j && Array.isArray(j.off)) I.skyOff = new Set(j.off.filter((k) => typeof k === 'string'));
      if (I && I.far && I.skyOff.has(I.far.name)) farEnd();
      if (I) for (const k of [...I.events.keys()]) if (I.skyOff.has(k)) eventEnd(k);
    }).catch(() => {});
  } catch { /* no server */ }
}
// the next kind: the first in the bag of kinds not shown yet (refilled, shuffled, once it is empty), skipping the off ones
function farPick() {
  for (let pass = 0; pass < 2; pass++) {
    while (I.farBag.length) { const k = I.farBag.pop(); if (FAR_KINDS.has(k) && !I.skyOff.has(k)) return k; }
    const ks = [...FAR_KINDS.keys()];
    for (let i = ks.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ks[i], ks[j]] = [ks[j], ks[i]]; }
    I.farBag = ks;
  }
  return null;
}
// whether the sky shows at (x, y) in the window: the map's canvas is there, or nothing with a fill of its own (a card,
// a tile, a panel, the header, the footer, a menu, a button) lies over the backdrop there. covered: a cache of each
// element's own fill for one call of farPlace
function skyShowsAt(x, y, covered) {
  const el = document.elementFromPoint(x, y);
  if (!el) return false; // off the window
  for (let e = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
    if (e === I.canvas) return true;
    let c = covered.get(e);
    if (c === undefined) {
      const cs = getComputedStyle(e), bg = /rgba?\(([^)]+)\)/.exec(cs.backgroundColor || '');
      const a = bg ? (bg[1].split(',').length > 3 ? Number(bg[1].split(',')[3]) : 1) : 0;
      c = a > 0.02 || (cs.backgroundImage && cs.backgroundImage !== 'none');
      covered.set(e, c);
    }
    if (c) return false;
  }
  return true;
}
// a place for an event reaching `reach` CSS px from its middle: of FAR_TRIES picks in the window (FAR_EDGE in from its
// edges where it fits) where the sky itself shows (its middle and four points round it, skyShowsAt: not under the
// header, the finished strip, the footer, a panel, a card or a button), the one furthest past FAR_CLEAR from every orb
// and hub the Map drew (each node's own radius too); null when no pick shows
function farPlace(reach) {
  const W = I.skyW || 1, H = I.skyH || 1, m = Math.min(reach + FAR_EDGE, W / 3), mh = Math.min(reach + FAR_EDGE, H / 3);
  const k = I.mapOn && I.cam ? K() : 1, ox = mapX(), oy = mapY();
  const nodes = I.mapOn ? I.nodes.filter((n) => n.sx !== undefined).map((n) => [n.sx + ox, n.sy + oy, (n.R || 8) * k]) : [];
  const e = Math.min(reach, 40) * 0.7, covered = new Map();
  const shows = (x, y) => [[0, 0], [e, 0], [-e, 0], [0, e], [0, -e]].every(([dx, dy]) => skyShowsAt(x + dx, y + dy, covered));
  let best = null, bs = -Infinity;
  for (let i = 0; i < FAR_TRIES; i++) {
    const x = m + Math.random() * Math.max(1, W - 2 * m), y = mh + Math.random() * Math.max(1, H - 2 * mh);
    if (!shows(x, y)) continue;
    let s = Infinity;
    for (const [nx, ny, nr] of nodes) s = Math.min(s, Math.hypot(x - nx, y - ny) - nr - reach);
    if (s > bs) { bs = s; best = [x, y]; }
    if (s > FAR_CLEAR * 3) break;
  }
  return best;
}
// how far a part reaches from the event's middle (CSS px), by its shape's edge (the shader's cut-offs)
const FAR_REACH = { 1: 2.5, 2: 1.4, 3: 1.2, 4: 1.5, 5: 1.2, 6: 1.3, 7: 1.2, 8: 1.1, 9: 1.1, 10: 1.3, 11: 1, 12: 1.1, 13: 1.3,
  14: 1.25, 15: 1.1, 16: 1.25, 17: 1.2, 18: 1.15, 19: 1.3, 20: 1.2, 21: 1.15, 22: 1.25, 23: 1.3, 24: 1.15 };
// a flash's light echo (FORM 24, after each part marked echo: web/sky-far.js flash): its light reaching the dust round
// it, a thin broken ring spreading from the point as the flash fades, fainter as it grows
function farEcho(q) {
  const t0 = q.t0 || 0, t1 = q.t1 == null ? 1 : q.t1, rise = q.rise == null ? 0.08 : q.rise, r = q.r0 || 6;
  return { f: 24, x: q.x || 0, y: q.y || 0, ...(q.to ? { to: q.to } : {}), ...(q.rgb ? { rgb: q.rgb } : {}), r0: r * 0.4, r1: r * 3,
    a: (q.a == null ? 0.85 : q.a) * 0.35, t0: t0 + (t1 - t0) * rise, t1, env: 'fade', ang: Math.random() * 6.2832 };
}
// start `name` at t: its recipe laid out at the window's scale, placed (farPlace) and logged; false when it is not in
// the catalog or the map is under reduced motion
function farStart(t, name) {
  const d = FAR_KINDS.get(name);
  if (!d || I.still) return false;
  if (I.far) farEnd();
  const R = { r: Math.random, in: (a, b) => a + Math.random() * (b - a), pick: (l) => l[Math.floor(Math.random() * l.length)], sg: () => (Math.random() < 0.5 ? -1 : 1) };
  const side = Math.min(I.skyW || FAR_SCALE_AT, I.skyH || FAR_SCALE_AT);
  const rec = d.make(R), sc = clamp(side / FAR_SCALE_AT, FAR_SCALE_K[0], FAR_SCALE_K[1]) * R.in(FAR_SIZE[0], FAR_SIZE[1]);
  const parts = rec.parts.flatMap((q) => (q.echo ? [q, farEcho(q)] : [q])).slice(0, FAR_N).map((q) => {
    const p = { x: 0, y: 0, to: null, a: 0.5, t0: 0, t1: 1, env: 'smooth', rgb: [1, 1, 1], ang: 0, spin: 0, p: 0, u0: 0, u1: 1, grow: false, seed: Math.random(), ...q };
    // a shell never stands still: one given no end size spreads a little
    p.r1 = p.r1 == null || (p.f === 2 && p.r1 === p.r0) ? p.r0 * (p.f === 2 ? 1.12 : 1) : p.r1;
    p.a = Math.min(1, p.a * FAR_GAIN);
    return p;
  });
  const scale = (s) => {
    for (const p of parts) {
      p.x *= s; p.y *= s; p.r0 *= s; p.r1 *= s;
      if (p.to) p.to = [p.to[0] * s, p.to[1] * s];
    }
  };
  // its reach: the furthest any part's edge gets, the big faint washes counted at no more than a fifth of the window
  const reachOf = () => {
    let r = 0;
    for (const p of parts) {
      const ex = Math.max(Math.hypot(p.x, p.y), p.to ? Math.hypot(p.to[0], p.to[1]) : 0), rr = Math.max(p.r0, p.r1) * (FAR_REACH[p.f] || 1.5);
      r = Math.max(r, Math.min(ex + rr, side / 5));
    }
    return r;
  };
  scale(sc);
  let reach = reachOf();
  // never too small to see nor so big it is in the way: its reach held within FAR_REACH_K of the shorter side
  const want = clamp(reach, FAR_REACH_K[0] * side, FAR_REACH_K[1] * side);
  if (reach > 0 && Math.abs(want / reach - 1) > 0.01) { scale(want / reach); reach = reachOf(); }
  const at = farPlace(reach);
  if (!at) return false;
  const cam = eventCam(EVENT_DEPTH.far), ms = rec.ms * FAR_LIFE[rec.quick ? 1 : 0];
  I.far = { name, at: t, ms, quick: !!rec.quick, cam, x: at[0], y: at[1], parts, reach }; I.dirty = true;
  skyLog(name, d.label, d.what, ms, at[0], at[1]);
  return true;
}
function farEnd() {
  if (!I.far) return;
  I.far = null; I.dirty = true;
  I.farAt = performance.now() + pickIn(FAR_GAP);
}
// each frame, as eventStep: none at rest or under reduced motion; the running one ends after its ms; the next comes FAR_GAP after
function farStep(t, rest) {
  if (t >= I.skyOffAt) skyOffRead(t);
  if (I.still || rest) {
    if (I.far) farEnd();
    I.farAt = 0;
    return;
  }
  if (I.far) {
    if (t - I.far.at >= I.far.ms) farEnd();
    return;
  }
  if (!I.farAt) I.farAt = t + pickIn(FAR_GAP);
  else if (t >= I.farAt) { const k = farPick(); if (!k || !farStart(t, k)) I.farAt = t + pickIn(FAR_GAP); }
}
// a part's light over its life (f 0-1 through its own t0..t1; age: ms since the event began): a 0-1, and how far it has
// come in (en) and gone out (ex), 0-1 each, which the shader turns into the shape's own way in and out (farPart: it
// gathers, grows, erodes, cools...). So the light's own edges are gentle (the square root of a smoothstep), and what shows
// is the shape changing, not a dimming; a flash keeps its light curve, 'rise' has its light by a quarter of its life and
// switches its shape on over the rest (en), and 'fade' dies all its life as much by its shape going (ex, slowly at
// first) as by its light, the two together about as fast as its light alone went before
function farEnv(q, f, age) {
  const sm = (v) => { v = clamp(v, 0, 1); return v * v * (3 - 2 * v); };
  const en = clamp(f / (q.fin != null ? q.fin : 0.15), 0, 1), ex = clamp(1 - (1 - f) / (q.fout != null ? q.fout : 0.2), 0, 1);
  const edge = Math.sqrt(sm(Math.min(en, 1 - ex)));
  // a flash: in as it rises, out as it decays (the point cools) and at its cut-off
  const fl = (rise, tau) => ({ a: (f < rise ? sm(f / rise) : Math.exp(-(f - rise) / tau)) * sm((1 - f) / 0.12), en: clamp(f / rise, 0, 1),
    ex: Math.max(f < rise ? 0 : 1 - Math.exp(-(f - rise) / tau), clamp(1 - (1 - f) / 0.12, 0, 1)) });
  switch (q.env) {
    case 'flash': return fl(q.rise != null ? q.rise : 0.08, q.tau != null ? q.tau : 0.25);
    case 'flicker': { const v = fl(q.rise != null ? q.rise : 0.1, q.tau != null ? q.tau : 0.3);
      v.a *= 0.7 + 0.3 * Math.sin(age / 170 + q.seed * 40) * Math.sin(age / 430 + q.seed * 9); return v; }
    case 'pulse': { const fo = q.floor != null ? q.floor : 0.1, ph = (age / (q.per || 2000) + (q.phase != null ? q.phase : q.seed)) % 1; return { a: edge * (fo + (1 - fo) * Math.exp(-(((ph - 0.5) / 0.07) ** 2))), en, ex }; }
    case 'rise': return { a: Math.sqrt(sm(f / 0.25) * sm((1 - f) / 0.1)), en: clamp(f / 0.85, 0, 1), ex: clamp(1 - (1 - f) / 0.1, 0, 1) };
    case 'fade': return { a: Math.sqrt(sm(f / 0.08)) * (1 - f) ** 0.8, en: clamp(f / 0.08, 0, 1), ex: f ** 1.6 };
    case 'dip': return { a: edge * (1 - 0.75 * Math.exp(-(((f - 0.5) / 0.07) ** 2))), en, ex };
    default: return { a: edge, en, ex };
  }
}
// the far event's parts showing now, at most FAR_N, in CSS px of the window: middle (x, y), size r, alpha a, shape (form),
// progress u, seed (+1: a trail that grows), turn ang, rgb, the shape's number p, the event's age t (s) and the part's
// way in and out (en, ex: farEnv). A part's orbit (radians/s) takes its place and turn round the event's middle; ease
// 'in' grows it slowly then fast (else fast then slowly); rgb1 is its colour at its end (from rgb at its start)
function farNow() {
  const e = I && I.far;
  if (!e) return [];
  const age = Math.max(0, performance.now() - e.at), g = age / e.ms, out = [];
  const k = Math.pow(clamp(I.zoom || 1, ZMIN, ZMAX), EVENT_DEPTH.far * STAR_ZOOM) / e.cam.sc;
  for (const q of e.parts) {
    const f = (g - q.t0) / Math.max(q.t1 - q.t0, 1e-3);
    if (f < 0 || f > 1) continue;
    const v = farEnv(q, f, age), a = q.a * v.a;
    if (!(a > 0.002)) continue;
    let ox = q.to ? q.x + (q.to[0] - q.x) * f : q.x, oy = q.to ? q.y + (q.to[1] - q.y) * f : q.y;
    const ob = q.orbit ? (q.orbit * age) / 1000 : 0;
    if (ob) { const c = Math.cos(ob), s = Math.sin(ob); [ox, oy] = [ox * c - oy * s, ox * s + oy * c]; }
    const [x, y] = eventAt(e.cam, e.x + ox, e.y + oy), ef = q.ease === 'in' ? f * f : 1 - (1 - f) * (1 - f);
    out.push({ x, y, r: (q.r0 + (q.r1 - q.r0) * ef) * k, a, form: q.f, u: q.u0 + (q.u1 - q.u0) * f, seed: q.seed + (q.grow ? 1 : 0),
      ang: q.ang + (q.spin * age) / 1000 + ob, rgb: q.rgb1 ? q.rgb.map((c, i) => c + (q.rgb1[i] - c) * f) : q.rgb, p: q.p,
      t: age / 1000, en: v.en, ex: v.ex });
    if (out.length >= FAR_N) break;
  }
  return out;
}
// the streaks showing now (a shower's later ones not yet), at most METEOR_N, in CSS px of the window: each one's head
// (hx, hy), tail end (tx, ty), rgb and alpha (> 0); the tail grows to its length as the head moves off, and the alpha
// fades in over its first fifth, out over its last half
function meteorsNow() {
  const out = [], now = performance.now();
  for (const m of I.meteors) {
    const s = now - m.at;
    if (s < 0 || out.length >= METEOR_N) continue;
    const e = clamp(s / METEOR_MS, 0, 1), d = (m.v * s) / 1000;
    const a = METEOR_A * Math.min(1, e / 0.2) * Math.min(1, (1 - e) / 0.5), l = Math.min(m.tail, d);
    if (a > 0) out.push({ hx: m.x + m.dx * d, hy: m.y + m.dy * d, tx: m.x + m.dx * (d - l), ty: m.y + m.dy * (d - l), rgb: m.rgb, a });
  }
  return out;
}
// the canvas draws the streaks (no WebGL2) as the sky's shader does: a line as wide as the shader's soft one
// carries light (METEOR_W sqrt(pi), its alpha squared from nothing at the tail to the head), and the head's glow as
// a radial gradient stepping down the same falloff (half the alpha in the middle, e^-(r / 2 METEOR_W)^2)
function drawMeteors(ctx) {
  const ms = meteorsNow();
  if (!ms.length) return;
  const w = 2 * METEOR_W;
  ctx.save();
  ctx.lineCap = 'butt';
  for (const m of ms) {
    const rgb = m.rgb.join(',');
    const line = ctx.createLinearGradient(m.tx, m.ty, m.hx, m.hy);
    for (const h of [0, 0.25, 0.5, 0.75, 1]) line.addColorStop(h, `rgba(${rgb},${m.a * h * h})`);
    const head = ctx.createRadialGradient(m.hx, m.hy, 0, m.hx, m.hy, 2 * w);
    for (const f of [0, 0.25, 0.5, 0.75, 1]) head.addColorStop(f, `rgba(${rgb},${f < 1 ? m.a * 0.5 * Math.exp(-4 * f * f) : 0})`);
    ctx.beginPath(); ctx.moveTo(m.tx, m.ty); ctx.lineTo(m.hx, m.hy);
    ctx.strokeStyle = line; ctx.lineWidth = METEOR_W * Math.sqrt(Math.PI); ctx.stroke();
    ctx.fillStyle = head;
    ctx.beginPath(); ctx.arc(m.hx, m.hy, 2 * w, 0, TAU); ctx.fill();
  }
  ctx.restore();
}

// ---------- the moon (see "Look", MOON_*) ----------
// the moon this minute: its phase (0-1, 0 new, 0.5 full), lit share, waxing, alpha (0: not shown) and middle (CSS px of
// the window, before the sky's slide: moonPlace); worked out again only when the minute or the window's size changes.
// Its path is laid over the window (I.moonF, the frame the satellites and rockets use too), so no panel, strip or menu
// ever moves it; only the pan does, as it does the stars
function moonNow() {
  const d = moonForce || new Date(), min = Math.floor(d.getTime() / 60000), h = skyHour();
  const vw = I.skyW || window.innerWidth || 1, vh = I.skyH || window.innerHeight || 1;
  if (!I.moonF || I.moonF.W !== vw || I.moonF.H !== vh) I.moonF = { x: 0, y: 0, W: vw, H: vh };
  const F = I.moonF, key = min + '|' + h.toFixed(3) + '|' + F.W + 'x' + F.H;
  if (I.moon && I.moon.key === key) return I.moon;
  const days = (d.getTime() - MOON_NEW) / 864e5, phase = (((days / MOON_MONTH) % 1) + 1) % 1;
  const frac = (1 - Math.cos(TAU * phase)) / 2;
  // its hour angle: it crosses the meridian phase x 24 h after the sun (noon), up while within 6 h of that
  let ha = h - 12 - 24 * phase;
  ha = ((((ha + 12) % 24) + 24) % 24) - 12;
  const alt = Math.cos((ha * Math.PI) / 12), ss = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  // shown by night, fading out over the morning and in at dusk, and as it nears the horizon
  const night = 1 - ss(MOON_DAY[0], MOON_DAY[1], h) * (1 - ss(MOON_DAY[2], MOON_DAY[3], h));
  const a = alt > 0 && frac >= MOON_MIN ? night * ss(0, 0.15, alt) : 0;
  I.moon = { key, phase, frac, waxing: phase < 0.5, a, ecl: eclipseAt(d), x: F.x + F.W * (0.5 + (MOON_SPAN * ha) / 6),
    y: F.y + F.H * (MOON_TOP + (MOON_LOW - MOON_TOP) * (1 - Math.max(0, alt))) };
  return I.moon;
}
// the eclipses' contacts (ms, UTC) and the shadow's path, worked out once: the umbra's middle passes the moon's at
// dmin (moon radii) at greatest, so its depth then is the magnitude (m = (ECL_RU + 1 - dmin) / 2), at a speed that
// brings its edge onto the limb at U1 and off at U4; north or south of the middle by turns
let eclTable = null;
function eclipseTable() {
  if (eclTable) return eclTable;
  eclTable = LUNAR_ECLIPSES.map(([td, mag, part, tot], i) => {
    const g = Date.parse(td + 'Z') - ECL_DT * 1000, hp = (part / 2) * 6e4, ht = (tot / 2) * 6e4;
    const dmin = Math.abs(ECL_RU + 1 - 2 * mag);
    return { g, mag, u1: g - hp, u2: tot ? g - ht : null, u3: tot ? g + ht : null, u4: g + hp, dmin: i % 2 ? -dmin : dmin,
      v: Math.sqrt((ECL_RU + 1) ** 2 - dmin * dmin) / hp };
  });
  return eclTable;
}
// the eclipse at this time, to the minute (null: none): where the umbra's middle is from the moon's (moon radii, y down;
// it comes in from the east, the left, and goes out west as the moon runs east through it) and how far in it is
function eclipseAt(d) {
  const t = Math.floor(d.getTime() / 6e4) * 6e4, e = eclipseTable().find((q) => t >= q.u1 && t <= q.u4);
  if (!e) return null;
  const x = e.v * (t - e.g), y = e.dmin;
  return { key: 'e' + t, x, y, total: e.u2 != null && t >= e.u2 && t <= e.u3 };
}
// the moon's picture at this dpr for its phase (to a 500th, about 1.4 h), painted once into a small canvas (premultiplied
// as a canvas keeps it) that both the sky's shader (as a texture) and the canvas use: a disc with the terminator an
// ellipse across it (the lit side's edge, at x = cos(2 pi phase) of the half-width on each row), soft over about a
// device px, the lit side a little darker towards the limb and over the seas, the dark side earthshine, and under it
// all the halo
function moonImage(phase, dpr, ecl) {
  const ph = Math.round(phase * 500) / 500, key = ph + '|' + dpr + (ecl ? '|' + ecl.key : '');
  if (I.moonImg && I.moonImg.key === key) return I.moonImg;
  const R = (MOON_D / 2) * dpr, S = 2 * Math.ceil(MOON_HALO_R * R) + 2, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d'), img = g.createImageData(S, S), px = img.data;
  const cs = Math.cos(TAU * ph), frac = (1 - cs) / 2, wax = ph < 0.5, soft = Math.max(0.9 / R, 0.05);
  const earth = MOON_EARTH * (0.35 + 0.65 * (1 - frac));
  let halo = MOON_HALO * Math.pow(frac, 0.8), glow = MOON_GLOW, red = 0;
  if (ecl) {
    // how deep the moon is in the umbra (0 at the first touch, 1 once all of it is in): the copper inside grows from
    // near black to ECL_TOT, and the halo dims and warms with it
    const dc = Math.hypot(ecl.x, ecl.y), deep = clamp((ECL_RU + 1 - dc) / 2, 0, 1);
    red = ECL_PART + (ECL_TOT - ECL_PART) * deep * deep * deep;
    // and deeper in once all of it is in: darkest at mid-totality, the more so the nearer the umbra's middle it passes
    red *= 1 - 0.45 * Math.sqrt(clamp((ECL_RU - 1 - dc) / (ECL_RU - 1), 0, 1));
    halo *= 1 - 0.8 * deep;
    glow = MOON_GLOW.map((v, k) => v + (ECL_RED[k] - v) * deep);
  }
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      const x = (i + 0.5 - S / 2) / R, y = (j + 0.5 - S / 2) / R, dd = Math.hypot(x, y);
      const cov = clamp((1 - dd) * R + 0.5, 0, 1);
      let r = 0, gg = 0, b = 0, A = 0;
      if (cov > 0) {
        const w = Math.sqrt(Math.max(0, 1 - y * y)), s = (wax ? x : -x) - w * cs;
        const l = clamp(s / (2 * soft) + 0.5, 0, 1), lit = l * l * (3 - 2 * l);
        let sea = 0;
        for (const [mx, my, mr, md] of MOON_MARIA) sea += md * Math.exp(-((x - mx) ** 2 + (y - my) ** 2) / (mr * mr));
        const bright = MOON_A * (0.8 + 0.2 * Math.sqrt(Math.max(0, 1 - dd * dd))) * (1 - Math.min(0.3, sea));
        const e = earth * (1 - 0.5 * Math.min(0.3, sea));
        // the Earth's shadow: inside the umbra (soft over a 20th of a radius) copper, darker towards its middle; just
        // outside it the penumbra dims the lit face
        let um = 0, pen = 0, cu = 0;
        if (ecl) {
          const ds = Math.hypot(x - ecl.x, y - ecl.y), q = clamp((ECL_RU + 0.05 - ds) / 0.1, 0, 1);
          um = q * q * (3 - 2 * q);
          pen = ECL_PEN * clamp(1 - (ds - ECL_RU) / 1.2, 0, 1);
          cu = red * (0.55 + 0.45 * clamp(ds / ECL_RU, 0, 1)) * (1 - 0.5 * Math.min(0.3, sea));
        }
        for (let k = 0; k < 3; k++) {
          const day = lit * bright * MOON_LIT[k] * (1 - pen), sh = lit * MOON_A * cu * ECL_RED[k];
          const v = cov * (day * (1 - um) + sh * um + (1 - lit) * e * MOON_SHINE[k]) / 255;
          if (k === 0) r = v; else if (k === 1) gg = v; else b = v;
        }
        A = cov * (lit * MOON_A + (1 - lit) * MOON_DARK);
      }
      // the halo under the disc, fading to nothing before the picture's edge
      const t = Math.max(0, dd - 1), ha = halo * Math.exp(-(t * t) / 0.8) * (1 - clamp((dd - (MOON_HALO_R - 0.7)) / 0.6, 0, 1));
      const left = 1 - A;
      r += left * ha * glow[0] / 255; gg += left * ha * glow[1] / 255; b += left * ha * glow[2] / 255; A += left * ha;
      const o = (j * S + i) * 4;
      if (A > 0) { px[o] = Math.round((255 * r) / A); px[o + 1] = Math.round((255 * gg) / A); px[o + 2] = Math.round((255 * b) / A); px[o + 3] = Math.round(255 * A); }
    }
  }
  g.putImageData(img, 0, 0);
  I.moonImg = { key, c, S };
  return I.moonImg;
}
// where the moon's middle is this frame (CSS px of the window): its place on its path, slid with the sky as the stars
// are (Henry 2026-10-14: it stayed put while the stars panned, so it seemed to follow the camera). The slide wraps
// every window plus MOON_WRAP px each way, so a long pan carries it off one side and back in from the other, both
// ends off the window, and it is never lost for good
function moonPlace(m) {
  const c = skyCam(), F = I.moonF, wrap = (v, P) => v - P * Math.round(v / P);
  return { x: m.x + wrap(-c.cx, 2 * F.W + MOON_WRAP), y: m.y + wrap(-c.cy, 2 * F.H + MOON_WRAP) };
}
// where the moon's picture goes this frame, in device px: its top left (whole px, so its texels sit on the screen's
// pixels), its size and alpha; null when it isn't shown
function moonAt(dpr) {
  const m = moonNow();
  if (!(m.a > 0)) return null;
  const im = moonImage(m.phase, dpr, m.ecl), p = moonPlace(m);
  return { im, x: Math.round(p.x * dpr - im.S / 2), y: Math.round(p.y * dpr - im.S / 2), a: m.a };
}
// the canvas draws the moon (no WebGL2): its picture, pixel for pixel
function drawMoon(ctx) {
  const dpr = I.dpr || 1, p = moonAt(dpr);
  if (!p) return;
  ctx.save();
  ctx.globalAlpha = p.a;
  ctx.drawImage(p.im.c, p.x / dpr, p.y / dpr, p.im.S / dpr, p.im.S / dpr);
  ctx.restore();
}

// ---------- satellites (see "Look", SAT_*) ----------
let satForce = null; // tests (__map.satellites): how many to show (null: one per running agent)
const satWant = () => (satForce != null ? Array.from({ length: satForce }, (_, i) => 'test:' + i) : I.satRun || []);
// a new path for satellite s across the window frame (I.moonF; px from its top left) at the map's clock: in from one
// side (or, mid, already somewhere along it, so a page full of agents doesn't send them all in from the edges at
// once), its tilt kept small enough that it stays within SAT_Y
function satPath(s, mid) {
  const F = I.moonF, W = F.W, H = F.H, T = pickIn(SAT_CROSS), dir = Math.random() < 0.5 ? 1 : -1, L = W + 2 * SAT_PAD;
  const lo = H * SAT_Y[0], room = H * (SAT_Y[1] - SAT_Y[0]);
  let dy = Math.tan(pickIn(SAT_TILT)) * L * (Math.random() < 0.5 ? -1 : 1);
  if (Math.abs(dy) > 0.8 * room) dy = Math.sign(dy) * 0.8 * room;
  s.x0 = dir > 0 ? -SAT_PAD : W + SAT_PAD; s.y0 = lo + Math.max(0, -dy) + Math.random() * (room - Math.abs(dy));
  s.vx = (dir * L) / T; s.vy = dy / T; s.T = T;
  s.t0 = I.time / 1000 - (mid ? Math.random() * T : 0);
  // the sky's camera as the path was laid, so it moves on from there with the nearest stars (SAT_DEPTH)
  const c = skyCam();
  s.cx0 = c.cx; s.cy0 = c.cy; s.sc0 = Math.pow(clamp(I.zoom || 1, ZMIN, ZMAX), SAT_DEPTH * STAR_ZOOM);
}
// a new satellite at the map's clock t (ms): its path, its beacon's rate and phase, fading in from t (snap: shown at once)
function satMake(t, snap) {
  const s = { born: snap ? -Infinity : t, end: null, per: pickIn(SAT_BLINK), ph: Math.random() * SAT_BLINK[1] };
  satPath(s, true);
  return s;
}
// each frame: a satellite for each running agent (SAT_N at most), fading out once its agent ends, a new path for one
// that crossed the window; at rest or under reduced motion they come and go at once (the clock fades go by is held)
function satStep(rest) {
  if (!I.skyW) return; // its paths are laid over the window once the sky has its size
  if (!I.moonF) moonNow();
  const want = satWant(), on = new Set(want), t = I.time, snap = I.still || rest;
  let changed = false;
  for (const [k, s] of I.sats) {
    if (on.has(k)) { if (s.end != null) { s.end = null; s.born = snap ? -Infinity : t; changed = true; } } // its agent runs again
    else if (s.end == null) { s.end = t; changed = true; }
    if (s.end != null && (snap || t - s.end >= SAT_FADE)) { I.sats.delete(k); changed = true; continue; }
    if (I.time / 1000 - s.t0 >= s.T) satPath(s, false);
  }
  for (const k of want) {
    if (I.sats.size >= SAT_N) break;
    if (!I.sats.has(k)) { I.sats.set(k, satMake(t, snap)); changed = true; }
  }
  if (changed) I.dirty = true;
}
// the satellites showing now, in CSS px of the window: each one's middle (x, y), alpha (> 0), its beacon's flash (f,
// 0-1, 0 under reduced motion) and colour (rgb, 0-1); laid over the window as the moon is, then panned and zoomed
// with the nearest star layer (SAT_DEPTH) from where its path was laid
function satsNow() {
  if (!I.sats.size) return [];
  const F = I.moonF || (moonNow(), I.moonF), t = I.time, ts = t / 1000, out = [];
  const c = skyCam(), sc = Math.pow(clamp(I.zoom || 1, ZMIN, ZMAX), SAT_DEPTH * STAR_ZOOM);
  const h = skyHour(), ss = (a, b, v) => { const q = clamp((v - a) / (b - a), 0, 1); return q * q * (3 - 2 * q); };
  const day = 1 - (1 - SAT_DAY) * ss(MOON_DAY[0], MOON_DAY[1], h) * (1 - ss(MOON_DAY[2], MOON_DAY[3], h));
  for (const s of I.sats.values()) {
    const fin = clamp((t - s.born) / SAT_FADE, 0, 1), fout = s.end == null ? 1 : clamp(1 - (t - s.end) / SAT_FADE, 0, 1);
    const a = SAT_A * day * fin * fout;
    if (!(a > 0)) continue;
    const e = ts - s.t0, px = F.x + s.x0 + s.vx * e, py = F.y + s.y0 + s.vy * e;
    const k0 = sc / (s.sc0 || sc);
    const x = c.mx + (px - c.mx) * k0 - (c.cx - (s.cx0 ?? c.cx)) * sc;
    const y = c.my + (py - c.my) * k0 - (c.cy - (s.cy0 ?? c.cy)) * sc;
    // the beacon: a short soft flash every s.per ms, red and white by turns
    const b = t + s.ph, k = Math.floor(b / s.per), w = b - k * s.per;
    const f = !I.still && w < SAT_FLASH ? Math.sin((Math.PI * w) / SAT_FLASH) : 0;
    out.push({ x, y, a, f, rgb: k % 2 ? SAT_RED : SAT_RGB });
  }
  return out;
}
// the canvas draws the satellites (no WebGL2): a small soft dot each, and its beacon's flash a little wider
function drawSats(ctx) {
  const ss = satsNow();
  if (!ss.length) return;
  ctx.save();
  for (const s of ss) {
    const dot = (r, rgb, a) => {
      const g = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, 2 * r);
      for (const q of [0, 0.25, 0.5, 0.75, 1]) g.addColorStop(q, `rgba(${rgb.map((v) => Math.round(v * 255)).join(',')},${q < 1 ? a * Math.exp(-4 * q * q) : 0})`);
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(s.x, s.y, 2 * r, 0, TAU); ctx.fill();
    };
    dot(SAT_R, SAT_RGB, s.a);
    if (s.f > 0) dot(SAT_FLASH_R, s.rgb, (SAT_FLASH_A * s.f * s.a) / SAT_A);
  }
  ctx.restore();
}

// ---------- a deploy's rocket (see "Look", ROCKET_*) ----------
// a rocket from t (ms, the streaks' clock) under hub n (or anywhere along the bottom when null): its rise, lean, bend
// and trail in the window frame (I.moonF); its foot is placed once the hub is on screen (rocketFoot); none at rest,
// hidden, under reduced motion or while ROCKET_N fly; false when none went up
function rocketLaunch(t, n) {
  if (I.still || resting() || !I.running || document.hidden || !I.skyW || I.rockets.length >= ROCKET_N) return false;
  if (!I.moonF) moonNow();
  const F = I.moonF, top = F.H * pickIn(ROCKET_TOP), side = Math.random() < 0.5 ? -1 : 1;
  I.rockets.push({ at: t, T: pickIn(ROCKET_MS), hub: n ? n.id : null, x0: null, top, lean: side * Math.tan(pickIn(ROCKET_TILT)),
    bend: (side * pickIn(ROCKET_BEND)) / top, tail: F.H * pickIn(ROCKET_TAIL), seed: 0.05 + 0.95 * Math.random() });
  I.rocketsN++;
  I.dirty = true;
  return true;
}
// each frame: none at rest or under reduced motion; a rocket is gone once its trail and sparks are (one more draw
// clears it)
function rocketStep(t, rest) {
  const R = I.rockets;
  if (!R.length) return;
  if (I.still || rest) { R.length = 0; I.dirty = true; return; }
  let keep = 0;
  for (const r of R) if (t - r.at < r.T + Math.max(ROCKET_FADE, ROCKET_PUFF_MS)) R[keep++] = r;
  if (keep < R.length) { R.length = keep; I.dirty = true; }
}
// rocket r's foot in the window frame F (px from its left), under its hub once a draw has put the hub on screen (a new
// state makes new nodes, placed by the next draw), kept within ROCKET_X; anywhere when it has none or it never shows;
// false while it waits for one (its first 200 ms, when it is barely lit)
function rocketFoot(r, F) {
  if (r.x0 != null) return true;
  const n = r.hub && I.mapOn ? I.byId.get(r.hub) : null;
  if (n && !Number.isFinite(n.sx) && performance.now() - r.at < 200) return false;
  const sx = n && Number.isFinite(n.sx) ? n.sx + mapX() - F.x : F.W * Math.random();
  r.x0 = clamp(sx, F.W * ROCKET_X[0], F.W * ROCKET_X[1]);
  return true;
}
// the trail's sideways waver (CSS px) at height s (CSS px above its foot), f of the way from its tail to the head: none at
// the head, more down the trail, slowly rippling (the sky's shader works it out the same way)
function rocketWave(r, s, f) {
  return r.wave * Math.pow(1 - f, 1.2) * (0.6 * Math.sin(s * 0.035 + r.ph * 3.1 + r.seed * 37.7) + 0.4 * Math.sin(s * 0.011 - r.ph * 1.7));
}
// the rockets flying now, in CSS px of the window: each one's foot (x0, yb: just below the window's bottom edge), its
// head's and its trail's tail end's heights above it (sh, st), lean and bend (x = x0 + lean s + bend s^2), the head's
// alpha (ha: in over 200 ms, a faint flicker, a flare and gone at burnout), the trail's (ta: fading after burnout as it
// shortens from below and wavers more), its clock (ph, s), the sparks' progress (puff, 0-1; -1: none) and seed
function rocketsNow() {
  if (!I.rockets.length) return [];
  const F = I.moonF || (moonNow(), I.moonF), now = performance.now(), out = [];
  const ox = F.x, yb = F.y + F.H + 2;
  for (const r of I.rockets) {
    const e = now - r.at;
    if (e < 0 || out.length >= ROCKET_N || !rocketFoot(r, F)) continue;
    const u = clamp(e / r.T, 0, 1), sh = r.top * (1 - Math.pow(1 - u, ROCKET_EASE)), after = Math.max(0, e - r.T);
    const q = Math.min(1, after / ROCKET_POP), fo = clamp(after / ROCKET_FADE, 0, 1), pp = after / ROCKET_PUFF_MS;
    const ha = e < r.T ? ROCKET_HEAD_A * Math.min(1, e / 200) * (0.9 + 0.1 * Math.sin(e * 0.05)) : ROCKET_HEAD_A * (1 - q) * (1 + 1.5 * Math.sin(Math.PI * q));
    const ta = ROCKET_TRAIL_A * Math.min(1, e / 250) * (1 - fo * fo * (3 - 2 * fo));
    if (!(ha > 0 || ta > 0 || pp < 1)) continue;
    out.push({ x0: ox + r.x0, yb, sh, st: sh - Math.min(r.tail, sh) * (1 - 0.5 * fo), lean: r.lean, bend: r.bend, ha, ta, ph: e / 1000,
      wave: ROCKET_WAVE * (1 + 1.5 * fo), puff: e >= r.T && pp < 1 ? pp : -1, seed: r.seed });
  }
  return out;
}
// where a rocket's head is (CSS px of the window)
const rocketHead = (r) => [r.x0 + r.lean * r.sh + r.bend * r.sh * r.sh, r.yb - r.sh];
// the canvas draws the rockets (no WebGL2) as the sky's shader does, simpler: the trail as short strokes up its path
// (each in its colour and alpha, a wider faint one under it), the head a soft dot, the sparks tiny ones
function drawRockets(ctx) {
  const rs = rocketsNow();
  if (!rs.length) return;
  const col = (c, a) => `rgba(${c.map((v) => Math.round(v * 255)).join(',')},${clamp(a, 0, 1)})`;
  const mix = (a, b, t) => a.map((v, j) => v + (b[j] - v) * t), sm = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const dot = (x, y, r, rgb, a) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, 2 * r);
    for (const q of [0, 0.25, 0.5, 0.75, 1]) g.addColorStop(q, col(rgb, q < 1 ? a * Math.exp(-4 * q * q) : 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, 2 * r, 0, TAU); ctx.fill();
  };
  ctx.save();
  ctx.lineCap = 'butt'; // round caps would bead where the strokes overlap
  for (const r of rs) {
    const at = (s, f) => [r.x0 + r.lean * s + r.bend * s * s + rocketWave(r, s, f), r.yb - s];
    if (r.ta > 0 && r.sh > r.st) {
      const K = 24;
      for (let i = 0; i < K; i++) {
        const f0 = i / K, f1 = (i + 1) / K, f = (f0 + f1) / 2, s0 = r.st + (r.sh - r.st) * f0, s1 = r.st + (r.sh - r.st) * f1;
        const [x0, y0] = at(s0, f0), [x1, y1] = at(s1, f1), a = r.ta * Math.pow(f, 1.3), w = 0.7 + 1.2 * (1 - f);
        const rgb = mix(mix(ROCKET_ORANGE, ROCKET_GOLD, sm(0, 0.6, f)), ROCKET_HEAD, sm(0.9, 1, f));
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
        ctx.strokeStyle = col(rgb, a * 0.22); ctx.lineWidth = 3 * w * Math.sqrt(Math.PI); ctx.stroke();
        ctx.strokeStyle = col(rgb, a); ctx.lineWidth = w * Math.sqrt(Math.PI); ctx.stroke();
      }
    }
    const [hx, hy] = rocketHead(r);
    if (r.ha > 0) { dot(hx, hy, 3 * ROCKET_HEAD_R, ROCKET_HEAD, 0.4 * r.ha); dot(hx, hy, ROCKET_HEAD_R, ROCKET_HEAD, r.ha); }
    if (r.puff >= 0) {
      const p = r.puff, rad = ROCKET_PUFF_R * (1 - (1 - p) * (1 - p)), a = 0.7 * Math.pow(1 - p, 1.5);
      for (let k = 0; k < ROCKET_PUFF_N; k++) {
        const an = ((k + r.seed) * TAU) / ROCKET_PUFF_N + 0.4 * Math.sin(k * 12.9 + r.seed * 50), d = rad * (0.7 + 0.3 * ((k * 0.618 + r.seed) % 1));
        dot(hx + d * Math.cos(an), hy + d * Math.sin(an) + 5 * p * p, 0.7, ROCKET_GOLD, a);
      }
    }
  }
  ctx.restore();
}

// the sky tint for hour h (0-24, fractional): top and bottom [r, g, b, a]
function skyAt(h) {
  h = ((h % 24) + 24) % 24;
  let i = 0;
  while (i < SKY_KEYS.length - 1 && SKY_KEYS[i + 1][0] <= h) i++;
  const a = SKY_KEYS[i], b = SKY_KEYS[(i + 1) % SKY_KEYS.length];
  const span = ((b[0] - a[0]) + 24) % 24 || 24, t = (h - a[0]) / span;
  const mix = (p, q) => [0, 1, 2].map((j) => Math.round(p[j] + (q[j] - p[j]) * t)).concat(Number((p[3] + (q[3] - p[3]) * t).toFixed(3)));
  return [mix(a[1], b[1]), mix(a[2], b[2])];
}
let skyForce = (() => { const m = typeof location !== 'undefined' && /[?&]skyHour=([\d.]+)/.exec(location.search); return m ? Number(m[1]) : null; })();
const sky2d = typeof location !== 'undefined' && /[?&]sky2d=1(&|$)/.test(location.search); // tests: the canvas draws the sky
let moonForce = null; // tests (__map.moon): the clock the moon and the tint go by
const skyHour = () => { if (skyForce != null) return skyForce; const d = moonForce || new Date(); return d.getHours() + d.getMinutes() / 60; };
// the canvas draws the tint (no WebGL2): one fillRect a frame; the gradient is rebuilt at most once a minute (or on a resize)
function drawSky(ctx) {
  const h = skyHour(), key = h.toFixed(3) + '|' + I.skyW + 'x' + I.skyH;
  if (!I.sky || I.sky.key !== key) {
    const [top, bot] = skyAt(h), g = ctx.createLinearGradient(0, 0, 0, I.skyH);
    g.addColorStop(0, `rgba(${top})`); g.addColorStop(1, `rgba(${bot})`);
    I.sky = { key, grad: g };
  }
  ctx.fillStyle = I.sky.grad; ctx.fillRect(0, 0, I.skyW, I.skyH);
}

// ---------- the sky on the graphics card ----------
// The sky's own WebGL2 canvas (I.skyCanvas) draws the whole sky in one full-screen pass: the page's colour (none in
// glass), the tint, the deep sky, then the star layers (the back one a repeating texture placed by starsAt, the
// front ones made per cell by the shader itself, STAR_FIELD_GLSL), the vignette, the repo glows (from their field,
// a small texture filled just before) and last the dither. A frame only
// works out the shader's uniforms and the glows' quads; when they are the ones last drawn it makes no GL calls and the canvas keeps its picture;
// when it drew a new one, the page's backdrop (I.skyEl, a 2D canvas over the whole window behind every view) copies it
// (one drawImage, skyPaint), and is left alone otherwise. The map's canvas, over the backdrop, is see-through but for
// the map itself. The sky's canvas is never on the page: shown, a WebGL canvas that changes keeps about four buffers of
// its size (a 1600x665 map at dpr 2: +90 MB of GPU memory), off the page about two (+40 MB). No WebGL2 (or only a
// software one, glSoftware), the context lost, or the sky's shader still compiling (skyGLInit): the backdrop draws the
// sky itself (drawSky, drawStars).
const SKY_GL_ATTRS = { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
  preserveDrawingBuffer: false, powerPreference: 'low-power', failIfMajorPerformanceCaveat: true };
// the shader's uniforms, every one a vec4, in this order in I.skyGL.u: the canvas in device px (x, y), the page's
// colour (premultiplied; 0 in glass), the tint's top and bottom (straight rgba) and, per star layer: with a tile, its
// offset in device px (x, y) and 1 / (scale x tile px) (z); made per cell, its star space at the top left (starWide;
// x, y), star px per device px (z) and device px per star px (w); then the deep sky's offset in device px and 1 / its
// size in device px (x, y), its star dust's the same way (1 / the tile's size in z), and the vignette, DEEP_A,
// DUST_A and the dither, the moon's picture's top left (device px; x, y), 1 / its size (z) and its alpha (w; 0:
// none), and the map's box in the window (uOrg: its top left and bottom right, device px; the glows are laid over it);
// uSize's z is the dpr, for the streaks' width, and its w the twinkle's clock (s, wrapped by TWINKLE_WRAP;
// -1 under reduced motion: none). After them (from SKY_M) the streaks' two arrays of METEOR_N vec4s: uM, each one's
// head and tail end (device px; x, y and z, w), and uMc, its rgb and alpha; the ones showing come first, the rest
// all 0 (the shader stops at the first with alpha 0); then the satellites' two arrays of SAT_N vec4s: uSat, each one's
// middle (device px; x, y), alpha and its beacon's flash alpha, and uSac, the flash's rgb, packed the same way; then the
// rockets' three arrays of ROCKET_N vec4s: uRk, each one's foot (device px; x, y) and its head's and trail's tail end's
// heights above it (device px), uRp, its lean, bend (per device px), head alpha and trail alpha, and uRw, its clock (s),
// waver (CSS px), sparks' progress (-1: none) and seed (> 0; 0: an empty slot); then the nebula drift's five vec4s, uNb
// (from SKY_NB): its middle (device px; x, y), long half-axis (device px) and alpha (w; 0: none), the cos and sin of its
// turn, its aspect and seed, its body, wisp and edge colours (rgb; w of the last: its age, s); then the asteroid field's
// uAs (from SKY_AS): ASTEROID_N rocks' vec4s, each one's middle (device px; x, y), long radius (device px) and alpha (w; 0: an
// empty slot), then ASTEROID_N more, its spin's cos and sin, aspect, and in w the edge blur (device px, whole; 0: a sharp
// rock) plus its seed (0-1) in the fraction, then one with the light's direction (x, y); then the gravity lens's uLn (from SKY_LN): its
// middle (device px; x, y), Einstein radius (device px) and alpha (w; 0: none), then per far galaxy two: its place from the lens's middle
// (device px; x, y), size (device px) and light (w; 0: none), and its turn's cos and sin and aspect (the first one's w: the ring's bright side); then the capital ship's uSh (from SKY_SH), five: its middle (device px; x, y), half-length (device px) and alpha (w; 0: none), its heading's cos and sin, flip (-1: it goes left, its top still up) and seed (0-1), then its escort's place from the ship's middle (in half-lengths along its heading, x, and across it, y), size (z, in the ship's; 0: no escort) and seed, then its jump's rift: its middle (device px; x, y), half-height (device px) and alpha (w; 0: shut), and the flash's alpha, the hull's smear (in its lengths), whether the hull is cut at the rift (z: 1 while it is open) and the clock (s). then the warp drift's uWp (from SKY_WP), two: its point (device px; x, y) and the squeeze's direction (z, w), then its stretch (x; 0: none), the direction's radial share (y) and the deep sky's share (z). The lens has four more after its galaxies: the stream it is eating (its distance (device px) and angle from the middle where it leaves the prey, its wind (radians per e-fold) and width (device px)), the stream's colour and alpha, then the flare (0-1), the jets' axis (radians), length and dark base (device px), then the clock (s); the ship one more: its heat (0-1) and how far it is off its course into a black hole (y). Then the planet's uPl (from SKY_PL) and the battle's uBt (from SKY_BT): see PLANET_GLSL's and BATTLE_GLSL's comments. Its textures (SKY_TEX's order is their unit): the star tiles (uS0 and up, only the layers
// without a cell), the deep sky, its star dust, the glows' noise and their field, and the moon's picture (moonImage).
// uTint (STAR_TINT) is set once.
const SKY_U = ['uSize', 'uBg', 'uTop', 'uBot', 'uL0', 'uL1', 'uL2', 'uD', 'uDu', 'uFx', 'uMo', 'uOrg'];
const SKY_M = SKY_U.length * 4;
const SKY_NB = SKY_M + METEOR_N * 8 + SAT_N * 8 + ROCKET_N * 12; // the nebula drift's five vec4s, after the rockets
const SKY_AS = SKY_NB + 20, SKY_LN = SKY_AS + (ASTEROID_N * 2 + 1) * 4, SKY_SH = SKY_LN + 36, SKY_WP = SKY_SH + 24, SKY_FR = SKY_WP + 8; // the asteroid field's vec4s, after the nebula; the lens's nine, then the ship's six, then the warp's two, then the far event's four per part (FAR_GLSL), after them
const SKY_BT_N = 2 + BATTLE_HULLS * 5 + BATTLE_STREAKS * 2 + BATTLE_BLASTS * 2;
const SKY_PL = SKY_FR + FAR_N * 16, SKY_BT = SKY_PL + 36, SKY_END = SKY_BT + SKY_BT_N * 4; // then the planet's nine and the battle's SKY_BT_N
const STAR_TILES = STAR_LAYERS.filter((L) => !L.cell);
const SKY_TEX = [...STAR_TILES.map((L, t) => 'uS' + t), 'uDeep', 'uDust', 'uNoise', 'uField', 'uMoon'];
const TEX_DEEP = SKY_TEX.indexOf('uDeep'), TEX_DUST = TEX_DEEP + 1, TEX_NOISE = TEX_DEEP + 2, TEX_FIELD = TEX_DEEP + 3;
const TEX_MOON = TEX_DEEP + 4;
// The repo glows (see NEB_*) are drawn by the same context, over the vignette and under the dither, so the 2D
// canvas gets sky and glows in its one drawImage, at the glows' place in its stack (nothing it draws comes between).
// Each frame with glows, every puff's lobes, heart, middle and lit spot go in as instanced quads (GLOW_VS, GLOW_FS),
// added up in a half-float texture (the field, I.skyGL.ft) at NEB_RES of the screen: each repo its own box in it,
// packed in rows, the quads cut to that box. A texel holds what the canvas path works out per repo: the lobes' sum,
// the hearts' sum, and the middles' and lit spots' cover as -log(1 - cover) summed (a product of what each leaves).
// The sky's pass then takes, per repo whose box holds the pixel, its texel (LINEAR), cuts the noise out (sampled at
// the field's scale), tints it and lays it on with 'screen' at NEB_A, in float, before the one dither: no 8-bit steps.
// Its uniforms: uGlow (CSS px per device px x NEB_RES, NEB_A, 1 / the field's size), per noise layer (uN0, uN1) its
// offset in device px, 1 / its tile in device px and its mip level, and per repo (up to GLOW_MAX) its box in field px
// (uGB) and its edge, middle and lit colours (uGE, uGC, uGL), the first two carrying in w where the box sits in the
// field texture (x, y, from the box's corner). Without a renderable half-float texture, more than GLOW_MAX repos on
// screen, a field taller than GLOW_ROWS screens, or ?glow2d=1, the canvas draws the glows (drawTerritories).
const GLOW_MAX = 32, GLOW_ROWS = 4, GLOW_INST = 12;
const glow2d = typeof location !== 'undefined' && /[?&]glow2d=1(&|$)/.test(location.search); // tests: the canvas draws the glows
// one triangle over the whole canvas
const SKY_VS = `#version 300 es
void main() { gl_Position = vec4(float((gl_VertexID & 1) << 2) - 1.0, float((gl_VertexID & 2) << 1) - 1.0, 0.0, 1.0); }`;
// the lobe's falloff (buildNeb's stops, t from its middle to its edge)
const NEB_GLSL = `float neb(float t) {
  t = clamp(t, 0.0, 1.0);
  return t < 0.3 ? mix(1.0, 0.8, t / 0.3) : t < 0.55 ? mix(0.8, 0.45, (t - 0.3) / 0.25) :
    t < 0.8 ? mix(0.45, 0.14, (t - 0.55) / 0.25) : mix(0.14, 0.0, (t - 0.8) / 0.2);
}`;
// a quad per lobe, heart, middle or lit spot (aC: its centre and radius in field texels, aW: what it adds to each
// channel, aR: its repo's box in the texture, which the quad is cut to)
const GLOW_VS = `#version 300 es
in vec4 aC, aW, aR;
uniform vec2 uA;
out vec2 vL;
out vec4 vW;
void main() {
  vec2 s = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
  vec2 q = clamp(aC.xy + s * aC.z, aR.xy, aR.zw);
  vL = (q - aC.xy) / aC.z; vW = aW;
  gl_Position = vec4(q / uA * 2.0 - 1.0, 0.0, 1.0);
}`;
const GLOW_FS = `#version 300 es
precision highp float;
in vec2 vL;
in vec4 vW;
out vec4 o;
${NEB_GLSL}
void main() {
  float f = neb(length(vL));
  o = vec4(f * vW.xy, -log(1.0 - min(f * vW.zw, 0.999)));
}`;
// the front star layers made by the sky's shader (see "Look"), so they never repeat: a layer's star space (a tile's
// px, placed by starWide) is cut into cells of L.cell px, and each cell's hash (pcg, of the cell wrapped by STAR_WRAP
// and the layer's seed) says whether it holds a star (as likely as the tile's density makes it, likelier where
// starDense says so), where (STAR_EDGE from the cell's edges), its radius, its alpha (skewed faint, as u1 u2), its tint
// (uTint, STAR_TINT: rgb and the weights summed up to it over their total) and whether it sparkles. It is drawn as
// starTile paints one (the sparkle's two crossed lines, a glow when r >= 0.8, the core, each over the last), smoothed
// over a device px, premultiplied like a tile's texel. Only twinkle moves with time (TWINKLE_*, uSize.w: the clock
// in s, below 0 when still): a bright star's draws go on down the chain (whether it twinkles, then its waves' rates
// and phases) after the ones above, so every star is where and as it was; a still frame draws the same stars.
const glf = (v) => (Number.isInteger(v) ? v + '.0' : String(v)); // a number as a GLSL float
const STAR_FIELD_GLSL = `#define STAR_WRAP ${STAR_WRAP}u
uniform vec4 uTint[${STAR_TINT.length}];
uint pcg(uint v) {
  uint s = v * 747796405u + 2891336453u, w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
float u01(uint h) { return float(h >> 8u) / 16777216.0; }
// a cell's hash, the cell wrapped by n cells (c is never below -n)
uint cellHash(ivec2 c, uint n, uint seed) { uvec2 w = uvec2(c + int(n)) % n; return pcg(w.x + pcg(w.y + pcg(seed))); }
// how much likelier a star is about star px q: a smooth noise over squares of STAR_SUPER px, mostly near 0, here and
// there up to 7 (1 on average)
float starDense(vec2 q, uint seed) {
  vec2 f = q / ${glf(STAR_SUPER)} - 0.5, i = floor(f), t = f - i;
  t = t * t * (3.0 - 2.0 * t);
  ivec2 c = ivec2(i);
  uint n = STAR_WRAP / ${STAR_SUPER}u, s = seed ^ 0x9e3779b9u;
  float a = pow(u01(cellHash(c, n, s)), 6.0), b = pow(u01(cellHash(c + ivec2(1, 0), n, s)), 6.0);
  float d = pow(u01(cellHash(c + ivec2(0, 1), n, s)), 6.0), e = pow(u01(cellHash(c + ivec2(1, 1), n, s)), 6.0);
  return 7.0 * mix(mix(a, b, t.x), mix(d, e, t.x), t.y);
}
// a disc of radius r, d from its middle (device px): its cover, smoothed over a px, its light kept (the ramp adds
// 1/12 px² to its area; one under half a px spreads to half a px, dimmer)
float starDisc(float d, float r) { float e = max(r, 0.5); return clamp(e + 0.5 - d, 0.0, 1.0) * r * r / (e * e + 0.0833); }
// a line along x through the middle, len either way and w wide (device px), flat ends: its cover, a thin one's light kept
float starLine(vec2 d, float len, float w) {
  float e = max(w, 1.0);
  return w / e * clamp(0.5 * e + 0.5 - abs(d.y), 0.0, 1.0) * clamp(len + 0.5 - abs(d.x), 0.0, 1.0);
}
// a layer's star (premultiplied) at device px p: l its uniform (see SKY_U), k its cell (px), dens its stars per cell,
// spark the share that sparkles, share cl's share, ra its radius and alpha ranges, twk the share of its bright stars
// that twinkle and t the twinkle's clock (s; below 0: none)
vec4 starField(vec2 p, vec4 l, float k, float dens, float spark, float share, vec4 ra, uint seed, float twk, float t) {
  vec2 q = p * l.z + l.xy, ci = floor(q / k);
  uint h = cellHash(ivec2(ci), STAR_WRAP / uint(k), seed);
  float u = u01(h);
  if (u >= dens * (1.0 + 6.0 * share)) return vec4(0.0);
  if (share > 0.0 && u >= dens * (1.0 - share + share * starDense((ci + 0.5) * k, seed))) return vec4(0.0);
  h = pcg(h); float x = u01(h);
  h = pcg(h); float y = u01(h);
  vec2 d = (q - ci * k - ${glf(STAR_EDGE)} - vec2(x, y) * (k - ${glf(2 * STAR_EDGE)})) * l.w;
  h = pcg(h); float r = mix(ra.x, ra.y, u01(h));
  h = pcg(h); float a = u01(h);
  h = pcg(h); float ab = a * u01(h); a = mix(ra.z, ra.w, ab);
  h = pcg(h); float tw = u01(h);
  h = pcg(h); bool sp = u01(h) < spark;
  // twinkle (TWINKLE_*): some of the bright ones, two slow waves of their own (whole cycles per TWINKLE_WRAP s, so
  // the clock's wrap never jumps)
  if (t >= 0.0 && twk > 0.0 && ab >= ${glf(1 - TWINKLE_TOP)}) {
    h = pcg(h);
    if (u01(h) < twk) {
      h = pcg(h); float f1 = floor(mix(${glf(TWINKLE_HZ[0])}, ${glf(TWINKLE_HZ[1])}, u01(h)) * ${glf(TWINKLE_WRAP)}) / ${glf(TWINKLE_WRAP)};
      h = pcg(h); float f2 = floor(mix(${glf(TWINKLE_HZ[0])}, ${glf(TWINKLE_HZ[1])}, u01(h)) * ${glf(TWINKLE_WRAP)}) / ${glf(TWINKLE_WRAP)};
      h = pcg(h); float p1 = u01(h);
      h = pcg(h); float p2 = u01(h);
      float wv = 0.6 * sin(6.2831853 * fract(f1 * t + p1)) + 0.4 * sin(6.2831853 * fract(f2 * t + p2));
      a *= clamp(1.0 + (sp ? ${glf(TWINKLE_SPARK)} : ${glf(TWINKLE_AMP)}) * wv, ${glf(TWINKLE_RANGE[0])}, ${glf(TWINKLE_RANGE[1])});
    }
  }
  vec3 col = uTint[${STAR_TINT.length - 1}].rgb;
  for (int i = ${STAR_TINT.length - 2}; i >= 0; i--) if (tw <= uTint[i].w) col = uTint[i].rgb;
  float s = l.w, dd = length(d), v = a * starDisc(dd, r * s);
  if (r >= 0.8) v = 1.0 - (1.0 - v) * (1.0 - a * 0.22 * starDisc(dd, 2.4 * r * s));
  if (sp) v = 1.0 - (1.0 - v) * (1.0 - a * 0.8 * max(starLine(d, 3.2 * s, 0.6 * s), starLine(d.yx, 3.2 * s, 0.6 * s)));
  return vec4(col * v, v);
}`;
// the warp drift (see "Look", WARP_*), uWp (see SKY_U's comment): where the sky is looked up for the pixel at p when its stars
// are stretched by up to k of the warp's stretch: the distance from the point along the direction (turned towards pointing
// away from the point by the radial share) is squeezed by 1 / (1 + stretch), so what is drawn there is that much longer
// along it and nothing else about it changes (its light, its width); p itself when there is no warp
const WARP_GLSL = `vec2 warpP(vec2 p, float k) {
  float s = uWp[1].x * k;
  if (s <= 0.0) return p;
  vec2 d = p - uWp[0].xy, dir = normalize(mix(uWp[0].zw, d / max(length(d), 1.0), uWp[1].y));
  return p - dir * (dot(d, dir) * s / (1.0 + s));
}`;
// a far event's part (see "Look", FAR_*; web/sky-far.js FORM), premultiplied, at device px p. uFr, four per part: A its
// middle (device px; x, y), size r (device px) and alpha (w), B its shape (x), progress u (y), seed (z; +1: a trail that
// grows, or arcs that close into a ring) and turn (w), C its rgb and the shape's number (w), D its clock: the event's age
// in s (x, t), how far the part has come in (y, en) and gone out (z, ex), 0-1 each (farEnv). Everything is worked in the
// part's own frame (q: turned, in radii), and a pixel past the shape's reach returns at once (FAR_REACH in the JS keeps the
// same edges). Each shape is drawn after the real thing in a deep photo: value noise (nbN, nbF, from the nebula) warped and
// seeded by the part's seed (so), so no two look the same, gives filaments, clumps, dust and torn edges; light is summed as
// m (how much) and lt (its colour times m), so one part can be white-hot in its core and its own colour in its wings, and
// a dark one's cover as shd. Every shape moves all its life by t (the event's age, so one started part-way in looks as a
// live one would): gas churns and turns, filaments writhe, discs and swarms go round (faster inside), knots and stars
// stream, light runs along the web, points scintillate. And none just fades: each comes in and goes out through its shape,
// by en and ex. Most are eaten from their outer edge and thin parts in by a drifting noise as tr = max(1 - en, ex) sweeps,
// and gather back the same way (farErode, at the end), the clouds also gathering in from a little wider and spreading out
// as they go (qk); some have a way of their own: a point lights its core, then its halo, then its spikes, and goes out
// cooling, its glare swelling; jets run out from the base and go dark from it; a spiral's arms wind up out of a glow and a
// galaxy recedes, smaller and redder; lensed arcs grow out of their images and shrink back into them; a swarm's points
// switch on one by one and cool red before each goes
const FAR_GLSL = `void farAdd(inout float m, inout vec3 lt, float w, vec3 c) { m += w; lt += w * c; }
// a ridged nbF: 1 along the noise's middle level, falling off both sides (thin crests where it crosses)
float farRidge(vec2 x, int n) { return 1.0 - abs(2.0 * nbF(x, n) - 1.0); }
// the distances to the three nearest points of a jittered grid (the web's filaments lie where the nearest two tie, its
// knots where three do)
vec3 farCells(vec2 g) {
  vec2 gi = floor(g);
  vec3 f = vec3(9.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 cc = gi + vec2(float(x), float(y));
    uvec2 h = uvec2(ivec2(cc) + 4096);
    float dd = length(g - cc - vec2(hash(h), hash(h + uvec2(17u, 31u))));
    if (dd < f.x) f = vec3(dd, f.xy); else if (dd < f.y) f = vec3(f.x, dd, f.y); else if (dd < f.z) f.z = dd;
  }
  return f;
}
// for the signature shapes (14 on): v turned by -a, as q is
vec2 farTurn(vec2 v, float a) { float c = cos(a), s = sin(a); return vec2(c * v.x + s * v.y, -s * v.x + c * v.y); }
// a field of small points near q, n cells per radius, a share dens of them holding one: its light (a dot about a CSS px
// across, larger with its pick b, which it hands back)
float farPts(vec2 q, float n, float dens, float px, vec2 so, out float b) {
  vec2 g = q * n + so, gi = floor(g);
  uvec2 h = uvec2(ivec2(gi) + 4096);
  b = hash(h + uvec2(3u, 77u));
  if (hash(h + uvec2(5u, 9u)) >= dens) return 0.0;
  vec2 dd = (g - gi - 0.25 - 0.5 * vec2(hash(h), hash(h + uvec2(17u, 31u)))) / (n * px * (0.8 + 0.8 * b));
  return exp(-dot(dd, dd));
}
// a spiral disc, g in its own plane (its edge at 1), tw its arms' turn, br its light: a warm bulge round a white nucleus,
// two noisy arms of blue clumps, dust on their inner side, pink star birth (sf: how much)
void farDisc(inout float m, inout vec3 lt, vec2 g, float tw, float br, float sf, vec2 so) {
  float R = length(g);
  if (R > 1.3 || br <= 0.0) return;
  float bulge = exp(-R * R * 14.0), nuc = exp(-R * R * 160.0);
  float ph = atan(g.y, g.x) - 2.6 * log(R + 0.05) - tw + 1.4 * (nbF(g * 2.6 + so, 3) - 0.5);
  float arm = pow(0.5 + 0.5 * cos(2.0 * ph), 3.0), disc = exp(-R * 2.6) * smoothstep(1.15, 0.5, R);
  float lane = pow(0.5 + 0.5 * cos(2.0 * ph + 1.1), 8.0) * smoothstep(0.08, 0.3, R) * smoothstep(1.1, 0.4, R);
  vec3 warm = vec3(1.0, 0.86, 0.62), blue = vec3(0.66, 0.78, 1.0);
  farAdd(m, lt, br * (0.85 * bulge + 0.4 * nuc), mix(warm, vec3(1.0), 0.6 * nuc));
  farAdd(m, lt, br * 0.75 * disc * (0.2 + 0.8 * arm) * (1.0 - 0.6 * lane), mix(warm, blue, smoothstep(0.1, 0.5, R)));
  float cl = br * disc * arm * (1.0 - 0.6 * lane) * smoothstep(0.15, 0.4, R);
  farAdd(m, lt, cl * 2.0 * pow(nbN(g * 16.0 + so + 7.0), 5.0), vec3(0.8, 0.88, 1.0));
  farAdd(m, lt, cl * sf * 1.6 * pow(nbN(g * 11.0 + so + 19.0), 6.0), vec3(1.0, 0.55, 0.68));
}
// diffraction spikes on a point at s (in radii, the screen's frame: spikes keep the telescope's way up): jw as JWST draws
// them (six long, two short across), else as Hubble's four; w their width (radii), k how fast they fall off, t the clock
// (their beads run out along them)
float farSpikes(vec2 s, float w, float k, bool jw, float t) {
  float L = length(s), bead = 0.75 + 0.25 * cos(L * 34.0 - t * 3.0), o = 0.0;
  if (jw) {
    for (int i = 0; i < 3; i++) {
      float an = 1.5708 + float(i) * 1.0472;
      vec2 t = vec2(cos(an), sin(an));
      o += exp(-abs(dot(s, vec2(-t.y, t.x))) / w) * exp(-abs(dot(s, t)) * k);
    }
    o += 0.45 * exp(-abs(s.y) / w) * exp(-abs(s.x) * k * 2.5);
  } else {
    vec2 a = abs(s);
    o = exp(-a.y / w) * exp(-a.x * k) + exp(-a.x / w) * exp(-a.y * k);
  }
  return o * bead;
}
// q's cell in a swarm laid out in rings (nk per radius, ring i cut into about 2 pi (i + 0.5) cells), each ring turning as a
// whole at w / (its middle + 0.25) rad/s at t s, so the inner ones go round faster and yet no point smears: from the cell's
// point (placed in it by its hash) to q, in radii; h the cell's hash key (s its seed), R the ring's middle, an its turn
vec2 farPolar(vec2 q, float nk, float t, float w, uint s, out uvec2 h, out float R, out float an) {
  float ri = floor(length(q) * nk), nc = max(1.0, floor(6.2831853 * (ri + 0.5) + 0.5));
  R = (ri + 0.5) / nk; an = w / (R + 0.25) * t;
  float ci = floor(fract((atan(q.y, q.x) - an) / 6.2831853) * nc);
  h = uvec2(uint(ri) + s, uint(ci) + 4096u);
  float pa = (ci + 0.25 + 0.5 * hash(h + uvec2(17u, 31u))) / nc * 6.2831853 + an;
  return q - (ri + 0.25 + 0.5 * hash(h)) / nk * vec2(cos(pa), sin(pa));
}
// how much of a shape shows at q (L its distance, px a CSS px, in radii) on its way in or out (tr: 0 all of it, 1 none):
// a drifting noise, mixed rs with how far in q is, cut where tr's sweep has got to, so it goes from its outer edge and
// thin parts in, torn into wisps, and comes in the same way backwards, gathering from its densest middle out. The noise
// and how far in are each about evenly spread over 0-1, so their mix is spread as the sum of two such: its CDF spreads it
// evenly again, and the sweep takes an even share of the shape at a time; the cut is softer on a small shape, so its
// wisps stay a px or two wide
float farErode(vec2 q, float L, float tr, float rs, vec2 so, float t, float px) {
  float n = smoothstep(0.22, 0.78, nbF(q * 1.8 + so + 23.0 + vec2(0.05, -0.035) * t, 4));
  float a = min(rs, 1.0 - rs), b = 1.0 - a, ab = max(2.0 * a * b, 1e-4), v = mix(n, 1.0 - clamp(L / 1.2, 0.0, 1.0), rs);
  v = v < a ? v * v / ab : v > b ? 1.0 - (1.0 - v) * (1.0 - v) / ab : (v - 0.5 * a) / b;
  float w = clamp(0.05 + 2.0 * px, 0.05, 0.2), th = tr * (1.0 + 2.0 * w) - w;
  return smoothstep(th - w, th + w, v);
}
vec4 farPart(vec2 p, vec4 A, vec4 B, vec4 C, vec4 D) {
  float r = max(A.z, 0.5), dp = uSize.z, u = B.y, sd = fract(B.z), pr = C.w, t = D.x, en = D.y, ex = D.z, tr = max(1.0 - en, ex);
  int fm = int(B.x + 0.5);
  vec2 d = p - A.xy;
  float cs = cos(B.w), sn = sin(B.w);
  // its frame's scale: a cloud (a remnant, a stream, gas, the web, a dark cloud, an echo) gathers in from a little wider and
  // spreads out as it goes; a galaxy recedes (smaller) as it goes
  float qk = fm == 2 || fm == 5 || fm == 8 || fm == 9 || fm == 13 || fm == 24 ? 1.0 / (1.0 + 0.3 * (ex * ex + (1.0 - en) * (1.0 - en)))
    : fm == 4 ? 1.0 + 0.5 * ex * ex : 1.0;
  vec2 q = vec2(cs * d.x + sn * d.y, -sn * d.x + cs * d.y) / r * qk;
  // ero: how much farErode takes it in and out (erl: the share of that by how far out), shd: a dark shape's cover (shk its
  // alpha)
  float L = length(q), px = dp / r * qk, m = 0.0, shd = 0.0, shk = 0.0, ero = 1.0, erl = 0.45;
  vec3 col = C.rgb, lt = vec3(0.0), wht = vec3(1.0);
  vec2 so = vec2(sd * 157.3, fract(sd * 7.37) * 89.1); // the seed's own corner of the noise
  float sw = fract(sd * 5.71) < 0.5 ? -1.0 : 1.0; // which way round it turns, where either will do
  if (fm == 1) { // a point: a small white-hot core, steep wings of its own colour, a halo whose rim the lens tints (a little
    // blue inside, warm outside) with a faint ring in it, a wide glare, and spikes (pr) beaded along their length, a faint
    // second pair between them. It scintillates a little, its halo breathes, faint rays stream out through its halo and
    // glare, and the beads run out along its spikes. In, it lights its core, then its halo and glare, the spikes last; out,
    // it cools (redder), its spikes going first and its core shrinking while its glare swells
    if (L > 2.5) return vec4(0.0);
    ero = 0.0;
    float kc = smoothstep(0.0, 0.3, en), kh = smoothstep(0.1, 0.65, en), ks = smoothstep(0.4, 1.0, en) * (1.0 - smoothstep(0.0, 0.5, ex));
    float sl = (1.0 + 1.4 * ex * ex) * (1.0 + 0.1 * sin(t * 1.3 + sd * 20.0) + 0.05 * sin(t * 2.9 + sd * 7.0)), H = L / sl;
    // the rays: a noise stretched along the radius (about 22 round, one a radius long) running out at 0.35 radii/s
    float kg = kh / sl * (0.65 + 0.7 * nbN(q / max(L, 1e-4) * 3.5 + so + (H - 0.35 * t) * 1.2 * vec2(0.6, 0.8)));
    vec3 cc = mix(col, vec3(1.0, 0.5, 0.32), 0.7 * ex), fr = mix(vec3(0.82, 0.9, 1.0), vec3(1.0, 0.82, 0.68), smoothstep(0.2, 0.8, H));
    float core = exp(-L * L * 30.0 * (1.0 + ex)) * kc * (1.0 + 0.14 * sin(t * 4.7 + sd * 40.0) * sin(t * 1.9 + sd * 13.0)), wing = exp(-H * 6.0);
    farAdd(m, lt, core, mix(wht, cc, 0.5 * ex));
    farAdd(m, lt, 0.55 * wing * kg, mix(cc, wht, 0.4 * wing * (1.0 - ex)));
    farAdd(m, lt, (0.16 * exp(-H * H * 1.6) + 0.05 * exp(-pow((H - 0.62) / 0.1, 2.0))) * kg, cc * fr);
    farAdd(m, lt, 0.12 * 0.04 / (0.04 + H * H) * smoothstep(2.5, 1.2, L) * kg, cc);
    if (pr > 0.0 && ks > 0.0) {
      vec2 aq = abs(q);
      float w = 0.55 * px, bead = 0.75 + 0.25 * cos(L * 34.0 - t * 3.0);
      float sp = 0.5 * bead * (exp(-aq.y / w) * exp(-aq.x * 1.1) + exp(-aq.x / w) * exp(-aq.y * 1.1))
        + 0.14 * (exp(-abs(q.x - q.y) * 0.7071 / w) + exp(-abs(q.x + q.y) * 0.7071 / w)) * exp(-L * 3.0);
      farAdd(m, lt, ks * pr * sp * smoothstep(2.5, 1.6, L), mix(wht, cc * fr, smoothstep(0.0, 0.6, L)));
    }
  } else if (fm == 2) { // a supernova remnant: a few thin filaments braided round its rim (each pushed in and out by its own
    // noise, so they cross and part) in a soft glow, broken in places, brighter in knots along them, a faint sharp shock just
    // outside (as ragged), a fibrous fill. Each filament's noise drifts its own way, so they writhe, and the knots twinkle
    if (L > 1.4) return vec4(0.0);
    erl = 0.3;
    float w = max(pr, 1.3 * px), fw = max(0.12 * w, 1.1 * px);
    vec2 nq = q * 2.2 + so;
    float whole = 0.2 + 0.8 * smoothstep(0.28, 0.62, nbF(nq * 0.8 + 3.1 + vec2(0.03, -0.02) * t, 3)), fil = 0.0;
    for (int k = 0; k < 3; k++) {
      float fk = float(k), ak = fk * 2.4 + sd * 6.2832;
      float rk = 1.0 - w * (0.1 + 0.3 * fk) + w * 1.1 * (nbF(nq * (1.0 + 0.6 * fk) + fk * 17.0 + vec2(cos(ak), sin(ak)) * 0.22 * t, 3) - 0.5);
      fil += (1.0 - 0.3 * fk) * exp(-pow((L - rk) / (fw * (1.0 + 0.4 * fk)), 2.0));
    }
    float knot = 1.8 * smoothstep(0.5, 0.8, nbF(q * 9.0 + so + 41.0 + vec2(0.0, 0.06) * t, 3)) * (0.6 + 0.4 * sin(t * 1.8 + 25.0 * nbN(q * 5.0 + so)));
    farAdd(m, lt, whole * 0.6 * fil * (1.0 + knot), mix(col, wht, 0.15 * knot));
    farAdd(m, lt, 0.25 * whole * exp(-pow((L - 1.0 + 0.2 * w) / max(w, 4.0 * px), 2.0)), col);
    float rsh = 1.0 + 0.3 * w + 0.5 * w * (nbF(nq * 0.6 + 23.0 + vec2(-0.04, 0.03) * t, 2) - 0.5);
    farAdd(m, lt, 0.22 * whole * exp(-pow((L - rsh) / max(0.35 * fw, px), 2.0)), mix(col, vec3(0.8, 0.9, 1.0), 0.6));
    farAdd(m, lt, 0.06 * smoothstep(1.0, 0.4, L) * (0.3 + farRidge(q * 3.5 + so + vec2(0.03, 0.02) * t, 3)), col * vec3(0.85, 0.92, 1.0));
  } else if (fm == 3) { // jets: a bright base, a narrow turbulent beam each way wandering a little (the one towards us, picked
    // by the seed, brighter), knots running out with u and with time, the turbulence and the bends streaming out with them,
    // a faint sheath round it, a lobe where it ends. In, the heads run out from the base and the lobes light as they get
    // there; out, the base shuts off first, the dark running out behind the last knots as they fly on, the lobes last
    if (L > 1.2) return vec4(0.0);
    ero = 0.0;
    float al = abs(q.x), sg = q.x < 0.0 ? -1.0 : 1.0, near = sg * (sd - 0.5) > 0.0 ? 1.0 : 0.5;
    float hd = 1.25 * smoothstep(0.0, 1.0, en), tl = 1.2 * ex, lit = smoothstep(hd + 0.03, hd - 0.1, al) * smoothstep(tl - 0.04, tl + 0.12, al);
    float wb = pr * (0.45 + 1.1 * al) + 0.7 * px;
    float y0 = pr * 2.5 * al * (nbF(vec2(al * 3.0 - 0.1 * t, sg * 5.0) + so, 2) - 0.5), yy = (q.y - y0) / wb;
    float turb = nbF(vec2((al - u * 0.4 - 0.1 * t) * 12.0, yy * 0.6) + so + sg * 31.0, 3);
    float knot = pow(0.5 + 0.5 * sin(al * 14.0 - u * 18.0 - t * 1.6 + sd * 30.0 + 2.5 * nbN(vec2(al * 3.0, sg) + so)), 3.0);
    float run = smoothstep(1.1, 0.4, al) * (0.3 + 0.7 * (1.0 - al)) * near * lit;
    farAdd(m, lt, exp(-yy * yy) * run * (0.35 + 0.5 * turb + 0.7 * knot), mix(col, wht, 0.35 * knot));
    farAdd(m, lt, 0.1 * exp(-yy * yy * 0.12) * smoothstep(1.0, 0.2, al) * near * (0.4 + turb) * lit, col);
    vec2 lq = vec2(al - 0.93, q.y - y0) / 0.12;
    farAdd(m, lt, 0.28 * exp(-dot(lq, lq)) * smoothstep(1.2, 1.05, al) * near * (0.4 + nbF(q * 9.0 + so + vec2(0.0, 0.08) * t, 3))
      * smoothstep(0.75, 1.05, hd) * (1.0 - smoothstep(0.75, 1.0, ex)), col);
    farAdd(m, lt, (0.8 * exp(-L * L * 80.0) + 0.2 * exp(-L * L * 12.0)) * smoothstep(0.0, 0.2, en) * (1.0 - smoothstep(0.0, 0.3, ex)), mix(col, wht, 0.6));
  } else if (fm == 4) { // a galaxy: pr > 0 a spiral seen at that aspect, < 0 an elliptical. A spiral: a warm bulge round a
    // white nucleus, two arms (their phase warped by noise, so never quite symmetric) of blue star clumps and pink star
    // birth, dark dust lanes on their inner side, and seen nearly edge-on a dust lane across the middle. Its arm pattern
    // turns slowly in its plane (the arms trailing), its clumps and star birth go round faster inside than out, in two
    // layers that each live a while (re-seeded while unseen, cross-faded with the other, so the shear never winds them up).
    // An elliptical: smooth, slightly irregular (its shape twisting slowly), a sharp core, (some) faint shells each off the
    // other side from the last, drifting out, a few globular clusters going round it, and a fine grain of its brightest
    // giants, each twinkling. In, a spiral's arms wind up out of a glow that gathers from its
    // middle out; out, it recedes, smaller (qk) and redder, its young stars going first and its outer parts before its core
    if (L > 1.5) return vec4(0.0);
    ero = 0.6; erl = 0.7;
    float asp = max(abs(pr), 0.12);
    vec2 g = vec2(q.x, q.y / asp);
    float R = length(g), bulge = exp(-R * R * 14.0), nuc = exp(-R * R * 160.0);
    col = mix(col, vec3(1.0, 0.6, 0.45), 0.55 * ex);
    vec3 warm = mix(col, vec3(1.0, 0.86, 0.62), 0.5);
    if (pr < 0.0) {
      float R2 = R * (1.0 + 0.1 * (nbN(farTurn(g, sw * 0.05 * t) * 2.0 + so) - 0.5));
      farAdd(m, lt, 0.8 * exp(-pow(R2 * 2.4, 1.2)) + 0.4 * bulge, mix(col, warm, 0.3 + 0.5 * bulge));
      farAdd(m, lt, 0.35 * nuc, mix(warm, wht, 0.5));
      float sh = R * 3.5 + sd * 1.4 - 0.05 * t, side = mod(floor(sh), 2.0) * 2.0 - 1.0;
      if (sd > 0.5) farAdd(m, lt, 0.06 * pow(sin(3.1416 * fract(sh)), 12.0) * smoothstep(1.2, 0.5, R) * smoothstep(0.15, 0.35, R)
        * pow(max(side * cos(atan(g.y, g.x) - sd * 6.2832), 0.0), 2.0), col);
      uvec2 h;
      float Rc, an;
      vec2 dd = farPolar(q, 9.0, t, -0.12, uint(sd * 9973.0) + 31u, h, Rc, an) / (px * 0.8);
      farAdd(m, lt, 0.3 * step(hash(h + uvec2(11u, 5u)), 0.25 * exp(-Rc * 1.5)) * exp(-dot(dd, dd)) * smoothstep(1.4, 0.9, L), warm);
      // its brightest giants, resolved: a fine grain over its body (cells about 3 CSS px), each twinkling, the whole turning
      float gb, gn = farPts(farTurn(q, sw * 0.05 * t), clamp(0.3 / px, 10.0, 40.0), 0.6 * exp(-R * 1.6), px, so + 13.0, gb);
      float tw = 0.5 + 0.5 * sin(t * (1.0 + 2.5 * gb) + gb * 60.0);
      farAdd(m, lt, 0.28 * gn * tw * tw * smoothstep(1.3, 0.4, R), mix(warm, wht, 0.4 * gb));
    } else {
      // in the arm pattern's frame, turning at 0.045 rad/s, its arms wound up as it comes in
      vec2 gp = farTurn(g, -0.045 * t);
      float wv = nbF(gp * 2.6 + so, 3) - 0.5, ph = atan(gp.y, gp.x) - 2.6 * (0.3 + 0.7 * smoothstep(0.0, 1.0, en)) * log(R + 0.05) - sd * 6.0 + 1.4 * wv;
      float arm = 0.5 + 0.5 * cos(2.0 * ph), armS = mix(0.31, arm * arm * arm, smoothstep(0.0, 0.9, en) * (1.0 - 0.5 * ex));
      float disc = exp(-R * 2.6) * smoothstep(1.15, 0.55, R);
      float lane = pow(0.5 + 0.5 * cos(2.0 * ph + 1.1), 8.0) * smoothstep(0.08, 0.3, R) * smoothstep(1.1, 0.4, R) * (0.4 + nbF(gp * 7.0 + so, 2));
      float edge = (1.0 - smoothstep(0.25, 0.6, asp)) * exp(-pow((q.y - 0.012) / (0.03 + 0.06 * asp), 2.0)) * smoothstep(1.0, 0.1, abs(q.x));
      float dust = (1.0 - 0.6 * lane) * (1.0 - 0.7 * edge);
      vec3 blue = mix(col, vec3(0.66, 0.78, 1.0), 0.45 * (1.0 - ex));
      farAdd(m, lt, (0.85 * bulge + 0.4 * nuc) * (1.0 - 0.7 * edge), mix(warm, wht, 0.6 * nuc));
      farAdd(m, lt, 0.75 * disc * (0.2 + 0.8 * armS) * dust, mix(warm, blue, smoothstep(0.1, 0.5, R)));
      // the clumps and star birth: two layers 8 s long, half a life apart, each going round at 0.08 / (R + 0.25) rad/s
      // about its middle (so the shear stays small) and drawn from a new corner of the noise each time round
      float clump = 0.0, hii = 0.0, ws = 0.0;
      for (int j = 0; j < 2; j++) {
        float lf = t / 8.0 + float(j) * 0.5, cy = floor(lf), fr = lf - cy, wj = 0.5 - 0.5 * cos(6.2832 * fr);
        vec2 gc = farTurn(g, -0.66 / (R + 0.25) * (fr - 0.5)) + so + cy * vec2(7.31, 3.17);
        clump += wj * pow(nbN(gc * 16.0 + 7.0), 5.0); hii += wj * pow(nbN(gc * 11.0 + 19.0), 7.0); ws += wj * wj;
      }
      float yk = disc * armS * dust * smoothstep(0.15, 0.4, R) * (1.0 - 0.8 * ex) / sqrt(ws);
      farAdd(m, lt, yk * 2.2 * clump, mix(blue, wht, 0.4));
      farAdd(m, lt, yk * 1.6 * hii * (1.0 - 0.5 * ex), vec3(1.0, 0.55, 0.68));
    }
  } else if (fm == 5) { // a stream of stars one radius long from the middle, bent by pr: a faint clumpy band wandering a
    // little, widening away from its source, with its own stars resolved along it, streaming out along it while the band
    // shimmers; a growing one (a trail) to u, widening behind its head, its stars staying where they were left
    if (L > 1.25) return vec4(0.0);
    erl = 0.3;
    float s, e, k = pr;
    if (abs(k) < 0.02) { s = q.x; e = q.y; }
    else { vec2 v = q - vec2(0.0, 1.0 / k); s = atan(k * v.x, -k * v.y) / k; e = length(v) - 1.0 / abs(k); }
    bool gr = B.z >= 1.0;
    float hd = max(u, 1e-3), sv = gr ? 0.0 : 0.03 * t;
    if (s < 0.0 || s > 1.0 || (gr && s > hd)) return vec4(0.0);
    float age = gr ? hd - s : s, lum = gr ? 0.3 + 0.7 * s / hd : pow(1.0 - s, 0.6);
    float wd = 0.02 + (gr ? 0.025 : 0.07) * age + 0.5 * px;
    float ew = e + wd * 0.8 * (nbF(vec2(s * 5.0 - 0.3 * sv, 0.0) + so, 2) - 0.5);
    farAdd(m, lt, 0.4 * exp(-pow(ew / wd, 2.0)) * lum * (0.35 + 0.9 * nbF(vec2((s - sv) * 14.0, ew / wd * 0.7 + 0.12 * t) + so + 5.0, 3)), col);
    float n = clamp(0.25 / px, 20.0, 120.0);
    vec2 gs = vec2(s - sv, ew) * n, gi = floor(gs);
    uvec2 h = uvec2(ivec2(gi) + 4096) + uvec2(uint(sd * 9973.0), 0u);
    float b = hash(h + uvec2(3u, 77u)), sz = 0.7 + 0.8 * b;
    vec2 dd = (gs - gi - 0.25 - 0.5 * vec2(hash(h), hash(h + uvec2(17u, 31u)))) / (n * px * sz);
    farAdd(m, lt, step(hash(h + uvec2(5u, 9u)), 0.55 * exp(-pow(ew / (wd * 1.3), 2.0)) * lum) * (0.35 + 0.75 * b * b) * exp(-dot(dd, dd)) * smoothstep(0.0, 0.05, s),
      mix(col, b > 0.8 ? vec3(1.0, 0.86, 0.66) : wht, 0.5 * b));
  } else if (fm == 6) { // a pair spiralling in: closer and faster as u goes to 1, going round all the while; pr the second's
    // light. Each a point with a halo, a bridge of gas pulled between them and a shared glow that grow as they close, two
    // faint streamers flung out
    if (L > 1.3) return vec4(0.0);
    float v = max(1.0 - u, 0.0), sep = pow(v, 0.25), ph = sd * 6.2832 + 70.0 * (1.0 - pow(v, 0.625)) + 0.35 * t;
    float pw = max(0.07, 1.5 * px);
    vec2 o = 0.5 * sep * vec2(cos(ph), sin(ph)), a1 = (q - o) / pw, a2 = (q + o) / pw;
    farAdd(m, lt, exp(-dot(a1, a1)) + 0.16 * exp(-dot(a1, a1) * 0.1), mix(col, wht, 0.5 * exp(-dot(a1, a1))));
    farAdd(m, lt, pr * (exp(-dot(a2, a2)) + 0.16 * exp(-dot(a2, a2) * 0.1)), col);
    float pea = length(q - o) * length(q + o) / pow(0.55 * sep + pw, 2.0);
    farAdd(m, lt, 0.28 * (0.25 + 0.75 * u) * (0.5 + 0.5 * pr) * exp(-pea * pea), col);
    farAdd(m, lt, 0.1 * u * exp(-L * L / pow(0.25 * sep + 0.12, 2.0)), col);
    float th = atan(q.y, q.x);
    farAdd(m, lt, 0.1 * (0.3 + 0.7 * u) * pow(0.5 + 0.5 * cos(2.0 * (th - ph) + 9.0 * L), 6.0) * exp(-L * 3.0) * smoothstep(0.1, 0.3, L)
      * smoothstep(1.25, 0.9, L) * (0.5 + nbF(q * 6.0 + so, 2)), col);
  } else if (fm == 7) { // a tidal disruption's debris: a torn arm of streaks (and a fainter one opposite) winding in to a hot
    // ring with one side brighter (its Doppler beaming) round a dark middle, turning with u and with time
    if (L > 1.2) return vec4(0.0);
    float th = atan(q.y, q.x), ph = th + 2.4 * log(max(L, 1e-3)) - u * 6.0 - 0.3 * t - sd * 6.2832, wv = 0.9 * (nbF(q * 3.0 + so, 3) - 0.5);
    float arm = pow(0.5 + 0.5 * cos(ph + wv), 5.0) + 0.35 * pow(0.5 + 0.5 * cos(ph + 3.1 + wv), 9.0);
    float streak = 0.5 + 0.5 * cos(13.0 * ph + 4.0 * nbN(q * 5.0 + so));
    farAdd(m, lt, arm * (0.4 + 0.6 * streak) * (0.5 + 0.8 * nbF(q * 7.0 + so, 3)) * smoothstep(1.1, 0.35, L) * smoothstep(0.08, 0.22, L),
      mix(col, vec3(1.0, 0.9, 0.8), 0.5 * smoothstep(0.45, 0.15, L)));
    farAdd(m, lt, 0.6 * exp(-pow((L - 0.13) / 0.03, 2.0)) * (0.55 + 0.45 * sin(th + sd * 6.2832)), mix(col, vec3(0.85, 0.92, 1.0), 0.7));
  } else if (fm == 8) { // a glow of gas, pr cells per radius: a noise warped by itself (pulled into streams) gives its density,
    // a ridged one along the same warp bright crests, a thin band round one level of another dark lanes; its edge is that
    // density added to its circle, so it frays; its colour pulled a little towards its own hues turned round, and white on
    // the crests. It churns (its warps drift, as the nebula's) and turns slowly
    if (L > 1.1) return vec4(0.0);
    erl = 0.35;
    float tm = 0.08 * t;
    vec2 x = farTurn(q, sw * 0.025 * t) * max(pr, 0.5) * 0.7 + so;
    vec2 w1 = vec2(nbF(x + vec2(tm, 0.0), 3), nbF(x + vec2(5.2, 1.3 - tm), 3));
    float dn = nbF(x + 2.2 * w1 + vec2(1.7, 9.2 + tm), 4), crest = pow(farRidge(x * 1.7 + 1.6 * w1 + vec2(3.3, 3.3 - tm), 3), 8.0);
    float lane = smoothstep(0.1, 0.02, abs(nbF(x * 1.3 + 2.0 * w1 + 7.7, 3) - 0.5)) * smoothstep(0.45, 0.7, nbN(x * 0.6 + 4.4 + tm));
    float body = smoothstep(0.32, 0.75, dn), edge = smoothstep(1.1, 0.25, L + 0.55 * (0.5 - dn)) * smoothstep(1.1, 0.95, L);
    vec3 c = mix(col, col.bgr, 0.35 * smoothstep(0.3, 0.7, w1.x));
    farAdd(m, lt, edge * (0.2 + 0.7 * body) * (1.0 - 0.5 * lane), c);
    farAdd(m, lt, edge * 0.5 * crest * (0.3 + body) * (1.0 - 0.5 * lane), mix(c, wht, 0.3));
  } else if (fm == 9) { // the cosmic web, pr cells per radius: curving filaments (the edges between cells, bent by noise),
    // their light varying along them in a faint haze, a finer web between, bright clumps where they meet. Light runs along
    // the filaments into the knots, the knots breathe, and the bends drift slowly
    if (L > 1.1) return vec4(0.0);
    erl = 0.3;
    vec2 g = q * pr + so;
    g += 0.35 * (vec2(nbF(g * 0.8 + vec2(3.0, 3.0 + 0.012 * t), 2), nbF(g * 0.8 + vec2(11.0 - 0.012 * t, 11.0), 2)) - 0.5);
    vec3 f = farCells(g);
    vec2 f2 = farCells(g * 2.3 + 17.0).xy;
    float e1 = f.y - f.x, wf = max(0.03, 1.2 * px * pr), fade = smoothstep(1.1, 0.3, L), nd = f.z - f.x;
    // nd is 0 at a knot and grows along each filament away from it: waves of light running in
    float flow = 0.65 + 0.35 * cos(nd * 25.0 + t * 1.5);
    farAdd(m, lt, fade * (exp(-pow(e1 / wf, 2.0)) * (0.4 + 0.9 * nbF(g * 2.0 + 5.0, 3)) * flow + 0.15 * exp(-e1 / 0.12)), col);
    farAdd(m, lt, fade * 0.35 * exp(-pow((f2.y - f2.x) / (wf * 2.3), 2.0)) * nbF(g * 1.5 + 9.0, 2), col * 0.9);
    farAdd(m, lt, fade * (0.7 + 0.6 * nbN(g * 1.3 + vec2(0.15, -0.1) * t)) * (0.6 * exp(-pow(nd / 0.1, 2.0)) + 0.15 * exp(-pow(nd / 0.3, 2.0))),
      mix(col, vec3(1.0, 0.9, 0.8), 0.5));
  } else if (fm == 10) { // an Einstein ring cut into pr arcs (1: whole, 4: a cross of short ones): each arc thickest in its
    // middle, a lensed galaxy's knots smeared along it (sliding slowly round), a fainter twin just outside, and a bright image
    // at its middle (the quasar's in a cross, each flickering on its own), its length breathing; growing (the seed's +1),
    // the arcs widen with u until they close into a full ring. In, the arcs grow out of their images; out, they shrink back
    // into them (a whole ring comes and goes as the others do)
    if (L > 1.3) return vec4(0.0);
    float n = max(pr, 1.0), seg = 6.2832 / n, th0 = atan(q.y, q.x), dth = mod(th0 + seg * 0.5, seg) - seg * 0.5;
    float hi = hash(uvec2(uint(mod(floor((th0 + seg * 0.5) / seg), n)) + 8u, uint(sd * 9973.0))); // its image's own pick
    float cl = B.z >= 1.0 ? smoothstep(0.0, 1.0, u) : 0.0, gw = max(smoothstep(0.0, 1.0, en) * (1.0 - smoothstep(0.0, 1.0, ex)), 0.02);
    float wid = (B.z >= 1.0 ? 0.06 * pow(30.0, pow(clamp(u, 0.0, 1.0), 3.0)) : n >= 4.0 ? 0.08 : n > 1.0 ? 0.3 : 9.0) * (1.0 + 0.12 * sin(t * 0.45 + hi * 6.2832)) * (n > 1.0 ? gw : 1.0);
    float along = exp(-pow(dth / (seg * wid), 2.0));
    ero = n > 1.0 ? 0.0 : 1.0;
    vec2 dir = q / max(L, 1e-4), dk = farTurn(dir, sw * 0.06 * t);
    float tv = 0.6 + 0.8 * nbN(dk * 2.5 + so), th = max(0.05, 1.3 * px) * (0.55 + 0.75 * along) * (n > 1.0 ? mix(1.0, tv, cl) : tv);
    float rr = 1.0 + 0.04 * (nbN(dir * 3.0 + so + 9.0) - 0.5);
    float knots = 0.45 + 1.1 * pow(nbF(dk * 7.0 + so, 3), 2.5);
    farAdd(m, lt, along * exp(-pow((L - rr) / th, 2.0)) * knots, mix(col, wht, 0.35 * clamp(knots - 0.8, 0.0, 1.0)));
    farAdd(m, lt, along * 0.35 * nbN(dk * 5.0 + so + 3.0) * exp(-pow((L - rr - th * 1.6) / (th * 0.6), 2.0)), col);
    if (n > 1.0) farAdd(m, lt, (n >= 4.0 ? 1.0 : 0.35) * (1.0 - cl) * smoothstep(0.0, 0.3, en) * (1.0 - smoothstep(0.6, 1.0, ex))
      * (0.75 + 0.25 * sin(t * (0.5 + 0.8 * hi) + hi * 40.0) * sin(t * (0.23 + 0.3 * hi) + hi * 13.0))
      * exp(-pow(dth * L / 0.05, 2.0) - pow((L - rr) / 0.05, 2.0)), mix(col, wht, 0.5));
  } else if (fm == 11) { // ripples running out to the front u, pr apart (further apart the further out: the older waves were
    // slower), stronger along one axis (the waves' quadrupole, turning slowly), shimmering
    if (L > 1.0 || L > u + 0.03) return vec4(0.0);
    float lam = max(pr, 0.03) * (0.7 + 0.6 * L / max(u, 0.05));
    m = pow(0.5 + 0.5 * cos((L - u) / lam * 6.2832), 10.0) * smoothstep(1.0, 0.15, L) * smoothstep(u + 0.03, u - 0.05, L) * smoothstep(0.03, 0.2, L)
      * (0.65 + 0.35 * cos(2.0 * (atan(q.y, q.x) - sd * 6.2832 - sw * 0.04 * t))) * (0.7 + 0.6 * nbN(q * 7.0 + so + vec2(0.3, -0.2) * t));
    lt = col * m;
  } else if (fm == 12) { // a swarm of points (pr: how many cells hold one), crowded to the middle: a few bright, many faint,
    // some smudged into far galaxies, each its own tint, twinkling; a faint mottled glow they share. It swirls, the inner
    // points going round faster (farPolar's rings). In and out point by point: each switches on at its own moment, and
    // cools red before it goes out at its own; the glow gathers and thins with them
    if (L > 1.1) return vec4(0.0);
    ero = 0.0;
    for (int k = 0; k < 2; k++) {
      float nk = k == 0 ? 7.0 : clamp(0.2 / px, 7.0, 16.0), Rc, an;
      uvec2 h;
      vec2 dd = farPolar(q, nk, t, sw * 0.04, uint(sd * 9973.0) + uint(k) * 977u, h, Rc, an) / px;
      if (hash(h + uvec2(5u, 9u)) >= pr * (k == 0 ? 1.0 : 0.6) * (0.55 + 0.9 * exp(-Rc * Rc * 2.5))) continue;
      float b = hash(h + uvec2(3u, 77u)), lum = k == 0 ? 0.2 + 1.0 * b * b * b : 0.12 + 0.3 * b;
      float sz = min(k == 0 ? 0.7 + 1.4 * b * b : 0.7, 0.12 / (nk * px));
      if (k == 0 && hash(h + uvec2(11u, 5u)) < 0.3) { // a smudge, keeping its turn as it goes round
        float a2 = hash(h + uvec2(23u, 2u)) * 6.2832 + an;
        dd = vec2(cos(a2) * dd.x + sin(a2) * dd.y, (-sin(a2) * dd.x + cos(a2) * dd.y) / (0.35 + 0.4 * hash(h + uvec2(29u, 13u))));
        sz = min(sz * 1.4, 0.12 / (nk * px)); lum *= 0.7;
      }
      float tw = 1.0 + 0.35 * sin(6.2832 * (mix(0.3, 1.0, hash(h + uvec2(41u, 3u))) * t + hash(h + uvec2(43u, 8u))));
      float hs = 0.8 * hash(h + uvec2(53u, 7u)), cool = smoothstep(hs - 0.2, hs + 0.05, ex);
      lum *= smoothstep(hs, hs + 0.2, en) * (1.0 - smoothstep(hs + 0.05, hs + 0.2, ex));
      float hk = hash(h + uvec2(47u, 19u));
      farAdd(m, lt, lum * tw * exp(-dot(dd, dd) / (sz * sz)), mix(mix(mix(col, vec3(1.0, 0.84, 0.66), step(0.7, hk) * 0.6), wht, 0.3 * b), vec3(1.0, 0.36, 0.24), cool));
    }
    farAdd(m, lt, 0.1 * pr * exp(-L * L * 3.0) * (0.5 + 0.9 * nbF(farTurn(q, sw * 0.053 * t) * 3.0 + so, 2)) * (tr > 0.0 ? farErode(q, L, tr, 0.5, so, t, px) : 1.0), col);
  } else if (fm == 13) { // a dark cloud: an absorbing patch, denser in clumps, its edge torn by noise; it rolls (its noise
    // drifting and turning)
    if (L > 1.3) return vec4(0.0);
    erl = 0.4;
    vec2 dq = farTurn(q, sw * 0.03 * t) + vec2(0.06, 0.04) * t;
    shd = smoothstep(1.2, 0.45, L + 0.5 * (nbF(dq * 2.2 + so, 4) - 0.5)) * (0.7 + 0.45 * nbF(dq * 5.0 + so + vec2(7.0, 7.0 + 0.1 * t), 3)) * smoothstep(1.3, 1.15, L);
    shk = A.w;
  } else if (fm == 14) { // a core-collapse supernova over its life u: a red supergiant; a white-blue flash with spikes (u
    // 0.04); then the blast wave (a thin, broken, blue-white shell) racing out and slowing, behind it a cage of filaments
    // with Rayleigh-Taylor fingers reaching in, knotted, cooling from blue-white to its colour, some knots oxygen teal; a
    // pulsar and its blue-white wind nebula in the middle later. Its filaments writhe slowly, its knots twinkle and the
    // wind nebula churns
    if (L > 1.25) return vec4(0.0);
    vec2 dir = q / max(L, 1e-4), sq = d / r, wr = vec2(0.03, -0.02) * t;
    float s = clamp((u - 0.04) / 0.96, 0.0, 1.0), Rs = 0.04 + 0.96 * (1.0 - pow(1.0 - s, 2.4)), cool = smoothstep(0.06, 0.55, u);
    float st = 1.0 - smoothstep(0.03, 0.045, u), fl = smoothstep(0.03, 0.045, u) * exp(-max(u - 0.045, 0.0) / 0.07);
    farAdd(m, lt, st * (0.7 * exp(-L * L / 0.0006) + 0.1 * exp(-L * 30.0)), vec3(1.0, 0.6, 0.4));
    farAdd(m, lt, fl * (1.4 * exp(-L * L / 0.0012) + 0.35 * exp(-L * 12.0) + 0.6 * farSpikes(sq, 0.6 * px, 3.0, false, t)),
      mix(vec3(0.8, 0.88, 1.0), wht, exp(-L * 20.0)));
    if (s > 0.0) {
      float Rl = Rs * (1.0 + 0.12 * (nbF(dir * 1.3 + so + 50.0, 2) - 0.5)), lr = L / Rl; // lopsided
      float x = (Rl - L) / (Rl * (0.1 + 0.5 * nbF(dir * 3.0 + so + 3.0, 2))); // 0 at the shell, 1 at a finger's tip
      float ridge = pow(farRidge(dir * 7.0 + so + vec2(lr * 2.2, lr * 1.1) + wr, 3), 6.0) * smoothstep(0.3, 0.65, nbF(dir * 2.2 + so + 61.0, 2));
      float web = pow(farRidge(q / Rl * 4.0 + so + 17.0 - wr, 3), 10.0) * smoothstep(0.55, 0.85, lr) * smoothstep(1.02, 0.9, lr);
      float fil = ridge * smoothstep(-0.04, 0.02, x) * smoothstep(1.05, 0.8, x) * (0.5 + smoothstep(0.55, 0.95, x)) + 0.7 * web;
      float rim = exp(-pow((L - Rl * 0.96) / (0.045 * Rl + px), 2.0)) * (0.2 + 1.3 * pow(nbF(dir * 7.0 + so + vec2(0.04 * t, L * 3.0), 3), 2.5));
      float br = (1.0 - 0.55 * smoothstep(0.5, 1.0, u)) * smoothstep(0.0, 0.03, s), kb;
      float kn = farPts(q, 40.0, 0.5, px, so + 9.0, kb) * (fil + rim) * (0.7 + 0.3 * sin(t * (1.0 + 2.0 * kb) + kb * 40.0));
      vec3 fc = mix(vec3(0.86, 0.92, 1.0), col, cool);
      float teal = smoothstep(0.55, 0.75, nbN(dir * 4.0 + so + 21.0)) * cool;
      farAdd(m, lt, br * (0.55 * fil + 0.45 * rim), mix(fc, vec3(0.46, 0.95, 0.8), 0.6 * teal));
      farAdd(m, lt, br * 0.9 * kn, mix(fc, wht, 0.5));
      float rb = Rl * (1.06 + 0.03 * (nbF(dir * 5.0 + so + 13.0, 2) - 0.5));
      farAdd(m, lt, br * 0.28 * exp(-pow((L - rb) / max(0.008, 1.1 * px), 2.0)) * (0.3 + 0.9 * nbF(dir * 6.0 + so + 31.0, 3)), vec3(0.72, 0.84, 1.0));
      farAdd(m, lt, br * 0.06 * smoothstep(1.0, 0.3, L / Rs) * (0.4 + farRidge(q / Rs * 3.0 + so, 3)), fc);
      vec2 pq = q / (0.3 * Rs);
      farAdd(m, lt, smoothstep(0.3, 0.6, u) * (0.22 * exp(-dot(pq, pq)) * (0.5 + 0.8 * farRidge(pq * 1.5 + so + 7.0 + vec2(0.05, 0.03) * t, 3)) + 0.6 * exp(-L * L / 0.0003)),
        vec3(0.7, 0.8, 1.0));
    }
  } else if (fm == 15) { // a kilonova over its life u: two neutron stars spiral in (closer, faster) under a faint two-armed
    // spiral of gravitational waves; they merge at u 0.32 in a hard white flash, a brief pair of narrow jets (the short
    // gamma-ray burst) along the part's x and a ring of waves running out; then the ejecta: a fast blue glow along the
    // poles that fades within days, and a slower, clumpy red one round the waist (fresh gold and platinum) that lasts
    if (L > 1.1) return vec4(0.0);
    float um = 0.32, x = clamp(u / um, 0.0, 1.0), v = 1.0 - x, th = atan(q.y, q.x);
    float sep = 0.3 * pow(v, 0.25), ph = sd * 6.2832 + 60.0 * (1.0 - pow(v, 0.625));
    if (u < um) {
      float pw = max(0.025, 1.3 * px);
      vec2 o = 0.5 * sep * vec2(cos(ph), sin(ph)), a1 = (q - o) / pw, a2 = (q + o) / pw;
      farAdd(m, lt, exp(-dot(a1, a1)) + exp(-dot(a2, a2)), wht);
      farAdd(m, lt, 0.25 * (exp(-dot(a1, a1) * 0.08) + exp(-dot(a2, a2) * 0.08)), col);
      farAdd(m, lt, 0.12 * x * x * exp(-L * L / pow(0.3 * sep + 0.04, 2.0)), col);
      float gw = pow(0.5 + 0.5 * cos(2.0 * (th - ph) + L * (20.0 + 30.0 * x)), 6.0);
      farAdd(m, lt, 0.08 * x * x * gw * smoothstep(0.05, 0.15, L) * smoothstep(1.0, 0.3, L), vec3(0.75, 0.7, 1.0));
    } else { // tk: the share of its life since the merger; the ejecta churn with the clock
      float tk = u - um, fl = exp(-tk / 0.012);
      farAdd(m, lt, fl * (1.6 * exp(-L * L / 0.0015) + 0.4 * exp(-L * 10.0) + 0.5 * farSpikes(d / r, 0.6 * px, 2.5, false, t)), wht);
      float jl = smoothstep(0.0, 0.004, tk) * exp(-tk / 0.03), jx = abs(q.x), hd = min(tk * 25.0, 1.0);
      farAdd(m, lt, jl * 0.8 * exp(-pow(q.y / (0.01 + 0.04 * jx + px), 2.0)) * smoothstep(hd + 0.02, hd - 0.1, jx), mix(col, wht, 0.6));
      float fr = tk * 3.5;
      farAdd(m, lt, 0.16 * exp(-tk / 0.15) * pow(0.5 + 0.5 * cos((L - fr) * 40.0), 4.0) * smoothstep(fr + 0.02, fr - 0.08, L) * smoothstep(fr - 0.4, fr - 0.1, L)
        * (0.6 + 0.4 * cos(2.0 * (th - ph))), vec3(0.75, 0.7, 1.0));
      float rb = 0.05 + 0.55 * pow(min(tk / 0.5, 1.0), 0.6);
      vec2 bq = vec2(q.x / rb, q.y / (rb * 0.55));
      farAdd(m, lt, smoothstep(0.0, 0.02, tk) * exp(-tk / 0.1) * 0.7 * exp(-dot(bq, bq) * 1.5) * (0.6 + 0.6 * nbF(bq * 2.5 + so + vec2(0.0, 0.2) * t, 3)), vec3(0.55, 0.7, 1.0));
      float rr = 0.04 + 0.35 * pow(min(tk / 0.68, 1.0), 0.6);
      vec2 rq = vec2(q.x / (rr * 0.75), q.y / rr);
      farAdd(m, lt, smoothstep(0.01, 0.08, tk) * exp(-max(tk - 0.08, 0.0) / 0.35) * 0.75 * exp(-dot(rq, rq) * 1.4) * (0.5 + 0.8 * nbF(rq * 2.0 + so + 5.0 + vec2(0.18, -0.14) * t, 4)),
        mix(vec3(1.0, 0.5, 0.25), vec3(0.9, 0.22, 0.14), smoothstep(0.1, 0.5, tk)));
      farAdd(m, lt, 0.5 * exp(-L * L / 0.0006) * smoothstep(0.0, 0.05, tk), vec3(1.0, 0.85, 0.75));
    }
  } else if (fm == 16) { // two spiral galaxies colliding over its life u: they fall together, swing past each other (u
    // 0.28), fling out two long curved tidal tails and a bridge, fall back and merge by u 0.82 into one glow with shells;
    // star birth (blue clusters, pink knots) lights up where they overlap and along the tails. Their discs turn all the
    // while and the tails' clumps stream out along them
    if (L > 1.25) return vec4(0.0);
    float dd0 = 0.72 - 0.52 * smoothstep(0.0, 0.28, u) + 0.22 * smoothstep(0.28, 0.45, u) - 0.42 * smoothstep(0.5, 0.82, u);
    float phi = 0.5 * u + 1.9 * smoothstep(0.12, 0.42, u) + 1.4 * smoothstep(0.52, 0.85, u);
    vec2 e = vec2(cos(phi), sin(phi)), c1 = 0.45 * dd0 * e, c2 = -0.55 * dd0 * e;
    float mg = smoothstep(0.7, 0.92, u), burst = smoothstep(0.3, 0.5, u) * (1.0 - 0.5 * smoothstep(0.85, 1.0, u));
    float tg = smoothstep(0.24, 0.6, u) * (1.0 - 0.5 * smoothstep(0.85, 1.0, u)), Lt = 0.1 + 0.8 * smoothstep(0.26, 0.75, u), tails = 0.0;
    for (int k = 0; k < 2; k++) {
      float fk = float(k), tl = 0.4 + 0.5 * fract(sd * (3.1 + fk * 2.3));
      vec2 c = k == 0 ? c1 : c2, g = farTurn(q - c, sd * 9.0 + fk * 2.1);
      farDisc(m, lt, vec2(g.x, g.y / tl) / (k == 0 ? 0.26 : 0.22), sd * 5.0 + fk * 3.0 - u * 2.0 - 0.02 * t, 0.85 * (1.0 - mg), burst, so + fk * 37.0);
      // its tail: from its far side at the swing past (phi 1.18), curving back behind the orbit
      vec2 w = q - c;
      float rr = length(w), sa = (rr - 0.1) / Lt;
      float dth = mod(atan(w.y, w.x) - (1.18 + fk * 3.1416 + 0.5 - 2.4 * max(rr - 0.1, 0.0)) + 3.1416, 6.2832) - 3.1416;
      float wd = 0.025 + 0.06 * clamp(sa, 0.0, 1.0) + px, e1 = dth * rr / wd;
      float tail = exp(-e1 * e1) * pow(max(1.0 - sa, 0.0), 0.5) * smoothstep(0.0, 0.1, sa) * (0.35 + 0.9 * nbF(vec2(rr * 9.0 - 0.12 * t, e1 * 0.5) + so + fk * 13.0, 3));
      tails += tail;
    }
    farAdd(m, lt, tg * 0.5 * tails, mix(col, wht, 0.2));
    vec2 cd = c2 - c1;
    float hb = clamp(dot(q - c1, cd) / max(dot(cd, cd), 1e-4), 0.0, 1.0), db = length(q - c1 - hb * cd);
    farAdd(m, lt, 0.2 * smoothstep(0.2, 0.32, u) * (1.0 - smoothstep(0.5, 0.72, u)) * exp(-pow(db / 0.035, 2.0)) * smoothstep(0.1, 0.3, hb) * smoothstep(0.9, 0.7, hb)
      * (0.4 + nbF(q * 9.0 + so + vec2(0.05, 0.0) * t, 3)), col);
    vec2 mid = 0.5 * (c1 + c2) - q;
    float kb, kn = farPts(q, 34.0, burst * (0.4 * exp(-dot(mid, mid) / 0.03) + 0.25 * min(tails * tg, 1.0)), px, so + 3.0, kb);
    farAdd(m, lt, kn * (0.6 + 0.9 * kb) * (0.75 + 0.25 * sin(t * (1.0 + 2.0 * kb) + kb * 40.0)), kb > 0.55 ? vec3(1.0, 0.55, 0.68) : vec3(0.75, 0.85, 1.0));
    // the merged remnant
    farAdd(m, lt, mg * (0.9 * exp(-L * L / 0.006) + 0.35 * exp(-L * 6.0)), vec3(1.0, 0.86, 0.66));
    farAdd(m, lt, mg * 0.07 * pow(sin(3.1416 * fract(L * 5.0 + sd)), 12.0) * smoothstep(0.7, 0.2, L) * smoothstep(0.08, 0.2, L) * (0.5 + 0.5 * cos(atan(q.y, q.x) - sd * 6.2832 + floor(L * 5.0 + sd) * 3.1416)), col);
  } else if (fm == 17) { // a tidal disruption over its life u: a star falls in on a parabola (its pericentre 0.1 radii off
    // the black hole, at u 0.25), stretched more the nearer it gets; past it, torn into a thin stream along its orbit,
    // the head flung out, the bound end falling back and winding in to a hot disc that flares (white-blue at u 0.42, then
    // dimming as t^-5/3) with one side brighter as it turns; a faint outflow rings out. The stream's clumps flow along it
    if (L > 1.2) return vec4(0.0);
    if (sd > 0.5) q.y = -q.y;
    float rp = 0.1, th = atan(q.y, q.x);
    float tt = -8.85 * (1.0 - u / 0.25), ths = 2.0 * atan(2.0 * sinh(asinh(1.5 * tt) / 3.0));
    vec2 sp = 2.0 * rp / (1.0 + cos(ths)) * vec2(cos(ths), sin(ths)), tv = vec2(-sin(ths * 0.5), cos(ths * 0.5));
    // the star, stretching as it nears, gone into the stream after
    float el = 1.0 + 7.0 * smoothstep(0.16, 0.26, u), pw = max(0.02, 1.3 * px);
    vec2 dq = q - sp, sa = vec2(dot(dq, tv) / (pw * el), dot(dq, vec2(-tv.y, tv.x)) / pw);
    float star = (1.0 - smoothstep(0.24, 0.3, u)) * exp(-dot(sa, sa)) * (1.0 + 0.6 * smoothstep(0.15, 0.24, u));
    farAdd(m, lt, star + 0.2 * (1.0 - smoothstep(0.24, 0.3, u)) * exp(-dot(dq, dq) / 0.004), vec3(1.0, 0.86, 0.6));
    // the stream: along the parabola between where its tail and its head are
    float ta = -0.6 + 1.6 * smoothstep(0.24, 0.8, u), tb = ths + 0.25 * smoothstep(0.2, 0.3, u);
    float rc = 2.0 * rp / max(1.0 + cos(th), 1e-3), perp = abs(L - rc) * cos(th * 0.5), wd = 0.006 + 0.03 * rc + px;
    float inr = smoothstep(ta - 0.05, ta + 0.15, th) * smoothstep(tb + 0.02, tb - 0.1, th);
    float strm = smoothstep(0.2, 0.28, u) * (1.0 - smoothstep(0.6, 0.85, u)) * inr * smoothstep(1.15, 0.8, L) * exp(-pow(perp / wd, 2.0)) * (0.5 + 0.8 * nbF(vec2(th * 9.0 - 0.3 * t, perp / wd) + so, 3));
    farAdd(m, lt, 0.75 * strm, mix(vec3(1.0, 0.75, 0.5), col, 0.5));
    // the bound debris falling back, winding in
    float fb = smoothstep(0.3, 0.4, u) * (1.0 - smoothstep(0.6, 0.85, u));
    float arm = pow(0.5 + 0.5 * cos(th - 3.0 * log(max(L, 1e-3)) - u * 40.0 + 1.5 * nbN(q * 6.0 + so)), 6.0);
    farAdd(m, lt, 0.35 * fb * arm * smoothstep(0.06, 0.12, L) * smoothstep(0.4, 0.15, L), col);
    // the disc, the flare, the outflow
    float flare = smoothstep(0.37, 0.42, u) * pow(1.0 + max(u - 0.42, 0.0) / 0.04, -1.667), dsc = smoothstep(0.36, 0.45, u);
    float ring = exp(-pow((L - 0.1) / 0.045, 2.0)) * (0.55 + 0.45 * sin(th + u * 30.0)) * (0.6 + 0.4 * cos(9.0 * th + 6.0 * log(max(L, 1e-3)) - u * 90.0));
    farAdd(m, lt, dsc * (0.25 + 0.75 * flare) * 0.8 * ring, mix(col, vec3(0.85, 0.92, 1.0), 0.6 * flare + 0.3));
    farAdd(m, lt, flare * (1.3 * exp(-L * L / 0.0025) + 0.35 * exp(-L * 9.0)), vec3(0.8, 0.88, 1.0));
    float Ro = 0.12 + 1.3 * max(u - 0.45, 0.0);
    farAdd(m, lt, 0.1 * smoothstep(0.45, 0.5, u) * (1.0 - smoothstep(0.7, 1.0, u)) * exp(-pow((L - Ro) / 0.05, 2.0)) * (0.4 + nbF(q * 5.0 + so + 9.0 + vec2(0.04, -0.03) * t, 3)), vec3(0.7, 0.8, 1.0));
  } else if (fm == 18) { // a long gamma-ray burst over its life u: a hard, flickering white flash with long spikes (u 0.01),
    // two needle-thin jets along the part's x with knots racing out from a hot cocoon (the dying star they punched
    // through), then the afterglow: a point fading as a power law and reddening, a faint shock ring slowing as it spreads,
    // and the supernova under it brightening at u ~0.6 and fading. The cocoon and the shock's clumps churn
    if (L > 1.15) return vec4(0.0);
    float pf = smoothstep(0.0, 0.006, u) * exp(-max(u - 0.006, 0.0) / 0.025) * (0.6 + 0.4 * nbN(vec2(u * 400.0, sd * 50.0)));
    farAdd(m, lt, pf * (1.8 * exp(-L * L / 0.0015) + 0.5 * exp(-L * 7.0) + 0.9 * farSpikes(d / r, 0.55 * px, 1.8, false, t)), mix(vec3(0.85, 0.85, 1.0), wht, exp(-L * 12.0)));
    float jt = smoothstep(0.004, 0.012, u) * exp(-max(u - 0.012, 0.0) / 0.07), jx = abs(q.x), hd = min(1.0, 0.05 + u * 9.0);
    float kn = pow(0.5 + 0.5 * sin(jx * 40.0 - u * 300.0 + sd * 20.0), 4.0);
    farAdd(m, lt, jt * exp(-pow(q.y / (0.006 + 0.02 * jx + 0.6 * px), 2.0)) * smoothstep(hd + 0.02, hd - 0.15, jx) * (0.35 + 0.9 * kn) * (q.x > 0.0 ? 1.0 : 0.6),
      mix(vec3(0.7, 0.8, 1.0), wht, 0.5 * kn));
    float cg = min(u / 0.2, 1.0);
    vec2 cq = vec2(q.x / (0.03 + 0.25 * cg), q.y / (0.02 + 0.08 * cg));
    farAdd(m, lt, smoothstep(0.004, 0.03, u) * exp(-u / 0.15) * 0.35 * exp(-dot(cq, cq)) * (0.5 + nbF(cq * 2.0 + so + vec2(0.05, 0.0) * t, 3)), vec3(1.0, 0.62, 0.42));
    float ag = smoothstep(0.005, 0.015, u) * pow(1.0 + max(u - 0.015, 0.0) / 0.02, -1.1);
    vec3 agc = mix(mix(vec3(0.75, 0.82, 1.0), vec3(1.0, 0.8, 0.5), smoothstep(0.02, 0.15, u)), vec3(1.0, 0.45, 0.3), smoothstep(0.15, 0.5, u));
    farAdd(m, lt, ag * (1.0 * exp(-L * L / 0.0008) + 0.25 * exp(-L * 14.0)), mix(agc, wht, 0.4 * exp(-L * L / 0.0008)));
    float Rk = 0.05 + 0.8 * sqrt(max(u - 0.01, 0.0));
    farAdd(m, lt, 0.06 * smoothstep(0.01, 0.05, u) * (1.0 - smoothstep(0.4, 0.8, u)) * exp(-pow((L - Rk) / (0.02 + 0.03 * Rk), 2.0)) * (0.4 + nbF(q * 6.0 / max(Rk, 0.1) + so + 0.04 * t, 3)), col);
    float sn = smoothstep(0.35, 0.6, u) * (1.0 - smoothstep(0.62, 0.95, u));
    farAdd(m, lt, sn * (0.7 * exp(-L * L / 0.0012) + 0.15 * exp(-L * 12.0)), vec3(1.0, 0.85, 0.6));
  } else if (fm == 19) { // a quasar in its galaxy over its life u, switching on (pr > 0) or off (pr < 0): a blinding core
    // with JWST's spikes, the host's disc round it, cones of ionised gas (teal) along the part's x and radio lobes (violet,
    // |pr|) fed by thin jets at their ends; light from the change spreads at light speed, so the cones and the host light
    // up (or go dark) from the middle out, an echo ring running through the disc. The disc turns, the cones' gas streams out
    // and the lobes churn
    if (L > 1.3) return vec4(0.0);
    bool up = pr > 0.0;
    float on0 = up ? smoothstep(0.12, 0.4, u) : 1.0 - smoothstep(0.35, 0.62, u), ue = u - L * 0.45;
    float on = up ? smoothstep(0.12, 0.4, ue) : 1.0 - smoothstep(0.35, 0.62, ue), lb = abs(pr);
    float echo = exp(-pow((ue - (up ? 0.26 : 0.48)) / 0.03, 2.0));
    vec2 g = farTurn(q, sd * 7.0);
    g = vec2(g.x, g.y / (0.45 + 0.4 * sd)) / 0.75;
    float m0 = m;
    farDisc(m, lt, g, sd * 6.0 - 0.04 * t, 0.5 + 0.3 * on, 0.4, so);
    float dl = m - m0, gl = exp(-length(g) * 1.5) * smoothstep(1.2, 0.6, length(g));
    farAdd(m, lt, 0.6 * echo * gl * (0.4 + nbF(g * 5.0 + so + 3.0, 3)), vec3(0.75, 0.85, 1.0));
    float ax = abs(q.x), cone = smoothstep(0.45, 0.2, abs(q.y) / max(ax, 1e-3)) * smoothstep(0.04, 0.15, ax) * smoothstep(0.7, 0.3, ax);
    farAdd(m, lt, 0.22 * on * cone * (0.12 + 1.3 * pow(farRidge(vec2(ax - 0.12 * t, q.y) * 6.0 + so + (q.x < 0.0 ? 31.0 : 0.0), 3), 4.0)), vec3(0.45, 0.95, 0.8));
    farAdd(m, lt, 0.12 * lb * exp(-pow(q.y / (0.005 + 0.012 * ax + px), 2.0)) * smoothstep(0.95, 0.8, ax) * smoothstep(0.02, 0.08, ax), mix(col, wht, 0.4));
    vec2 lq = vec2((ax - 0.98) / 0.13, q.y / 0.17);
    farAdd(m, lt, lb * (0.3 * exp(-dot(lq, lq)) * (0.4 + nbF(lq * 2.0 + so + 9.0 + vec2(0.0, 0.06) * t, 3)) + 0.5 * exp(-dot(lq - vec2(0.7, 0.0), lq - vec2(0.7, 0.0)) * 12.0)), vec3(0.74, 0.58, 1.0));
    farAdd(m, lt, on0 * (2.0 * exp(-L * L / 0.0008) + (0.5 * exp(-L * 14.0) + 0.12 * 0.03 / (0.03 + L * L)) * (1.0 + 0.25 * sin(t * 1.7 + sd * 20.0) * sin(t * 0.63 + sd * 7.0)) + 0.6 * farSpikes(d / r, 0.55 * px, 1.6, true, t)),
      mix(vec3(0.8, 0.88, 1.0), wht, exp(-L * 25.0)));
  } else if (fm == 20) { // a magnetar's giant flare over its life (u counts its turns, pr of them in all): a tiny neutron
    // star, its field's closed loops glowing round it and two beams along its tilted magnetic pole, turning with it (they
    // foreshorten as it turns, and the core blips when a beam sweeps past us); the flare a blinding flash at the start,
    // then the ringing tail of pulses dying away, and a lopsided cloud of ejecta spreading, churning as it goes
    if (L > 1.2) return vec4(0.0);
    float lf = u / max(pr, 1.0), ph = (u + sd) * 6.2832, inc = 0.5;
    vec3 Om = vec3(0.0, cos(inc), sin(inc)), mg = 0.62 * Om + 0.78 * (cos(ph) * vec3(1.0, 0.0, 0.0) + sin(ph) * vec3(0.0, sin(inc), -cos(inc)));
    float mp = length(mg.xy);
    vec2 ax = mg.xy / max(mp, 1e-3);
    float al = dot(q, ax), pp = dot(q, vec2(-ax.y, ax.x));
    float tail = exp(-lf / 0.3), fl = smoothstep(0.0, 0.004, lf) * exp(-max(lf - 0.004, 0.0) / 0.012), pulse = exp(-(1.0 - abs(mg.z)) / 0.02) * tail;
    farAdd(m, lt, (0.6 + 0.9 * pulse + 3.0 * fl) * exp(-L * L / 0.0005) + (0.08 + 0.3 * pulse + 0.6 * fl) * exp(-L * 12.0) + 0.7 * fl * farSpikes(d / r, 0.55 * px, 2.0, false, t),
      mix(col, wht, 0.6));
    farAdd(m, lt, (0.12 + 0.5 * pulse) * (0.3 + 0.7 * tail) * exp(-pow(pp / (0.01 + 0.12 * abs(al)), 2.0)) * smoothstep(0.75 * mp + 0.05, 0.1 * mp, abs(al)) * smoothstep(0.0, 0.03, abs(al)),
      mix(col, wht, 0.4));
    vec2 fq = vec2(al / max(mp, 0.3), pp);
    float R2 = length(fq), Lk = R2 * R2 * R2 / max(pp * pp, 1e-6);
    float loops = pow(0.5 + 0.5 * cos(log(Lk) * 14.0 + 2.0 * fl * nbN(fq * 12.0 + so)), 10.0) * smoothstep(0.02, 0.05, R2) * exp(-R2 * 5.0) * smoothstep(0.7, 0.35, Lk);
    farAdd(m, lt, 0.6 * (0.35 + 0.65 * tail + 1.5 * fl) * loops, col);
    float Re = 0.08 + 0.85 * sqrt(lf);
    vec2 eq = (q - Re * 0.3 * vec2(cos(sd * 20.0), sin(sd * 20.0))) / Re;
    eq.x /= 1.3;
    float LE = length(eq);
    farAdd(m, lt, 0.25 * smoothstep(0.0, 0.03, lf) * (1.0 - 0.7 * lf) * (0.3 * exp(-pow((LE - 0.8) / 0.3, 2.0)) + 0.25 * smoothstep(1.0, 0.2, LE)) * 1.6 * pow(nbF(eq * 3.0 + so + vec2(0.03, -0.02) * t, 4), 2.0),
      mix(col, vec3(1.0, 0.56, 0.72), 0.4));
  } else if (fm == 21) { // two black holes merging over its life u (pr: the second's mass, a share of the first's): the
    // stars and a faint galaxy behind bent round each into arcs and Einstein rings, its shadow dark with a thin photon ring;
    // they spiral in, closer and faster, under a two-armed spiral of gravitational waves (the colour), merge at u 0.6 into
    // one bigger shadow that rings (oblate, settling round) as a strong wave runs out. The stars behind drift past, their
    // images sliding round the rings
    if (L > 1.15) return vec4(0.0);
    float um = 0.6, x = clamp(u / um, 0.0, 1.0), v = 1.0 - x, th = atan(q.y, q.x), tb = u - um; // tb: since the merger
    float sep = 0.42 * pow(v, 0.25), ph = sd * 6.2832 + 55.0 * (1.0 - pow(v, 0.625)), m2 = clamp(pr, 0.2, 1.0);
    float E1 = 0.12, E2 = 0.12 * sqrt(m2), Ef = sqrt(E1 * E1 + E2 * E2);
    vec2 e = vec2(cos(ph), sin(ph)), c1 = sep * m2 / (1.0 + m2) * e, c2 = -sep / (1.0 + m2) * e, d1 = q - c1, d2 = q - c2, b;
    if (tb < 0.0) {
      b = q - E1 * E1 * d1 / max(dot(d1, d1), 1e-5) - E2 * E2 * d2 / max(dot(d2, d2), 1e-5);
      float l1 = length(d1), l2 = length(d2), s1 = 0.4 * E1, s2 = 0.4 * E2;
      shd = max(smoothstep(s1 + px, s1 - px, l1), smoothstep(s2 + px, s2 - px, l2));
      farAdd(m, lt, 0.5 * (exp(-pow((l1 - 1.1 * s1) / max(0.005, px), 2.0)) + exp(-pow((l2 - 1.1 * s2) / max(0.005, px), 2.0))), vec3(1.0, 0.9, 0.8));
    } else {
      b = q - Ef * Ef * q / max(L * L, 1e-5);
      float sf = 0.4 * Ef * (1.0 + 0.3 * exp(-tb / 0.03) * cos(2.0 * (th - ph) - tb * 400.0));
      shd = smoothstep(sf + px, sf - px, L);
      farAdd(m, lt, 0.5 * exp(-pow((L - 1.1 * sf) / max(0.005, px), 2.0)), vec3(1.0, 0.9, 0.8));
    }
    shk = min(1.0, A.w * 1.6);
    b = clamp(b, vec2(-40.0), vec2(40.0));
    float fade = smoothstep(1.1, 0.3, L), sb, sl = farPts(b + sw * vec2(0.012, 0.005) * t, 14.0, 0.22, px, so, sb);
    farAdd(m, lt, fade * sl * (0.3 + 0.9 * sb * sb), mix(wht, vec3(1.0, 0.84, 0.66), step(0.8, sb)));
    vec2 gq = (b - 0.05 * vec2(cos(sd * 40.0), sin(sd * 40.0))) / vec2(0.16, 0.1);
    farAdd(m, lt, fade * 0.45 * exp(-dot(gq, gq)) * (0.6 + 0.6 * nbF(gq + so, 3)), vec3(0.66, 0.78, 1.0));
    farAdd(m, lt, 0.07 * x * x * x * pow(0.5 + 0.5 * cos(2.0 * (th - ph) + L * (18.0 + 30.0 * x)), 6.0) * smoothstep(0.1, 0.2, L) * smoothstep(1.05, 0.4, L) * step(tb, 0.0), col);
    float fr = max(tb, 0.0) * 3.0;
    farAdd(m, lt, 0.2 * step(0.0, tb) * exp(-tb / 0.12) * pow(0.5 + 0.5 * cos((L - fr) * 45.0), 4.0) * smoothstep(fr + 0.02, fr - 0.08, L) * smoothstep(fr - 0.4, fr - 0.1, L), col);
  } else if (fm == 22) { // a ring galaxy forming over its life u (pr: when the intruder punches through): a spiral disc
    // until then; after, its arms fade as a ring of star birth (blue clusters, pink knots) runs out through the disc,
    // spokes reaching back to an inner ring round the yellow core. The disc turns and the ring's knots seethe
    if (L > 1.25) return vec4(0.0);
    float s = clamp((u - pr) / (1.0 - pr), 0.0, 1.0), hit = smoothstep(pr, pr + 0.04, u);
    vec2 g = farTurn(q, sd * 11.0);
    g.y /= 0.55 + 0.35 * sd;
    float R = length(g), th = atan(g.y, g.x);
    vec2 dir = g / max(R, 1e-4);
    farDisc(m, lt, g / 0.85, sd * 6.0 - u * 1.5 - 0.02 * t, 0.75 * (1.0 - 0.7 * hit), 0.3, so);
    if (hit > 0.0) {
      float Rr = 0.1 + 0.9 * s + 0.04 * (nbF(dir * 3.0 + so, 2) - 0.5), Ri = 0.06 + 0.22 * s;
      float ring = exp(-pow((R - Rr) / (0.035 + 0.04 * s), 2.0)) * (0.35 + 1.2 * pow(nbF(dir * 9.0 + so + vec2(3.0, 3.0 + 0.04 * t), 3), 2.0));
      float iring = exp(-pow((R - Ri) / 0.025, 2.0));
      float spk = pow(0.5 + 0.5 * cos(th * 9.0 + 3.0 * nbN(dir * 2.0 + so) + R * 4.0), 10.0) * smoothstep(Ri, Ri + 0.05, R) * smoothstep(Rr - 0.02, Rr - 0.1, R)
        * (0.2 + 1.2 * smoothstep(0.3, 0.7, nbN(dir * 4.0 + so + 40.0)));
      farAdd(m, lt, hit * (0.75 * ring + 0.35 * iring + 0.14 * spk * (0.4 + nbF(g * 6.0 + so, 2))), mix(col, wht, 0.25));
      float kb, kn = farPts(g, 36.0, 0.7 * min(ring, 1.0) + 0.25 * spk, px, so + 5.0, kb);
      farAdd(m, lt, hit * kn * (0.45 + 0.6 * kb) * (0.75 + 0.25 * sin(t * (1.0 + 2.0 * kb) + kb * 40.0)), kb > 0.6 ? vec3(1.0, 0.55, 0.68) : vec3(0.8, 0.88, 1.0));
      farAdd(m, lt, hit * 0.7 * exp(-R * R * 60.0), vec3(1.0, 0.82, 0.55));
    }
  } else if (fm == 23) { // a jellyfish galaxy over its life u, moving along the part's x through a cluster's hot gas: its
    // disc (its own tilt) pressed bright along its leading edge, its gas stripped back into tentacles trailing behind,
    // growing with u, wavering, blue-teal (the colour) with young blue clusters and pink knots of star birth along them.
    // Waves run back along the tentacles and their gas streams back; the disc turns
    if (L > 1.3) return vec4(0.0);
    vec2 g = farTurn(q, sd * 13.0);
    g = vec2(g.x, g.y / (0.35 + 0.4 * sd)) / 0.3;
    farDisc(m, lt, g, sd * 4.0 - u * 1.2 - 0.02 * t, 0.85, 0.5, so);
    float Rg = length(g), lead = smoothstep(0.2, 0.9, q.x / max(L, 1e-4));
    farAdd(m, lt, 0.4 * lead * exp(-pow((Rg - 0.85) / 0.15, 2.0)) * (0.4 + nbF(g * 6.0 + so + 2.0, 3)), vec3(0.75, 0.85, 1.0));
    float grow = smoothstep(0.02, 0.6, u), T = 0.0;
    for (int k = 0; k < 6; k++) {
      float fk = float(k), hk = fract(sd * 7.13 + fk * 0.618), y0 = (fk / 5.0 - 0.5) * 0.42 + 0.09 * (hk - 0.5);
      float x0 = -0.06 - 0.1 * hk, Lk = (0.55 + 0.45 * hk) * 0.95 * grow, s = (x0 - q.x) / max(Lk, 1e-3);
      if (s < -0.1 || s > 1.0) continue;
      float yc = y0 * (1.0 + 0.9 * max(s, 0.0)) + 0.12 * s * (nbF(vec2(q.x * 2.5 + 0.06 * t, fk * 3.1) + so, 2) - 0.5);
      float wd = 0.012 + 0.03 * max(s, 0.0) + px, e1 = (q.y - yc) / wd;
      T += exp(-e1 * e1) * pow(1.0 - max(s, 0.0), 0.6) * smoothstep(-0.1, 0.05, s) * (0.4 + 0.9 * nbF(vec2(q.x * 12.0 + 0.4 * t, e1) + so + fk * 7.0, 3));
    }
    farAdd(m, lt, 0.4 * T, col);
    farAdd(m, lt, 0.04 * grow * smoothstep(0.0, -0.3, q.x) * exp(-pow(q.y / (0.18 + 0.25 * max(-q.x, 0.0)), 2.0)) * smoothstep(1.2, 0.5, L), col);
    float kb, kn = farPts(q, 40.0, 0.4 * min(T, 1.0) * grow, px, so + 3.0, kb);
    farAdd(m, lt, kn * (0.6 + 0.9 * kb) * (0.75 + 0.25 * sin(t * (1.0 + 2.0 * kb) + kb * 40.0)), kb > 0.6 ? vec3(1.0, 0.55, 0.68) : vec3(0.7, 0.85, 1.0));
  } else if (fm == 24) { // a light echo (a flash's, farEcho): its light reaching sheets of dust round it as it spreads: a
    // soft, broken shell of lit dust, its sheets' edges bright (a ridged noise), swirled (the dust's noise turned more the
    // further out, and turning slowly), fainter sheets lit inside it; fading as it grows (env 'fade'), torn as it goes
    if (L > 1.15) return vec4(0.0);
    ero = 0.7; erl = 0.1;
    vec2 sq = farTurn(q, 1.6 * L + sw * 0.03 * t);
    float dust = nbF(sq * 3.0 + so, 4), fil = pow(farRidge(sq * 4.5 + so + 11.0, 3), 3.0);
    float brk = smoothstep(0.3, 0.7, nbF(farTurn(q / max(L, 1e-4), sw * 0.05 * t) * 2.2 + so + 7.0, 3));
    float shell = exp(-pow((L - 1.0 - 0.08 * (dust - 0.5)) / max(0.07, 1.6 * px), 2.0)), inner = smoothstep(1.0, 0.55, L) * smoothstep(0.3, 0.8, L);
    farAdd(m, lt, (shell * (0.35 + 0.8 * fil) * (0.15 + 0.85 * brk) + 0.1 * inner * fil) * (0.3 + 0.9 * dust), mix(col, vec3(0.8, 0.88, 1.0), 0.3));
  }
  // the way in and out: farErode takes ero of it (and of a dark one's cover, with softer edges: a dark cloud has no
  // sharp ones)
  if (tr > 0.0 && ero > 0.0) {
    float mk = mix(1.0, farErode(q, L, tr, erl, so, t, fm == 13 ? max(px, 0.06) : px), ero);
    m *= mk; lt *= mk; shd *= mk;
  }
  float a = clamp(m * A.w, 0.0, 1.0), sh = clamp(shd, 0.0, 1.0) * shk;
  return vec4(lt * (a / max(m, 1e-5)) * (1.0 - sh), a * (1.0 - sh) + sh);
}`;
// per star layer its line in SKY_FS: its tile's texel, or its stars made per cell
const STAR_GLSL = STAR_LAYERS.map((L, i) => (L.cell
  ? `c = over(starField(warpP(pl, ${glf(WARP_LAYER[i])}), uL${i}, ${glf(L.cell)}, ${glf(L.n * (L.cell / STAR_TILE) ** 2)}, ${glf((L.sparkle || 0) / L.n)}, ` +
    `${glf(L.cl ? L.cl[1] : 0)}, vec4(${L.r.concat(L.a).map(glf).join(', ')}), ${L.seed}u, ${glf(L.twinkle || 0)}, uSize.w), c);`
  : `c = over(star(uS${STAR_TILES.indexOf(L)}, uL${i}, warpP(pl, ${glf(WARP_LAYER[i])})), c);`)).join('\n  ');
// the nebula drift (see "Look", NEBULA_*), premultiplied, at device px p; uNb (see SKY_U's comment): the cloud lives in its
// own plane (middle, turn, long half-axis = 1), so its noise travels with it. A value noise, summed over octaves each turned
// and doubled (nbF), warped twice by itself (the dust looks pulled into streams), gives its density; a ridged noise along
// the same warp gives the filaments, and a thin band round one level of another noise the dark lanes. The cloud's edge is
// that density added to its ellipse, so it frays into wisps instead of ending in a curve. Colour: the body tint, pulled to
// the wisp tint where the warp is high and along the filaments, and to the edge tint in a ring where the cloud thins out.
const NEBULA_GLSL = `float nbN(vec2 x) {
  vec2 i = floor(x), f = x - i;
  f = f * f * (3.0 - 2.0 * f);
  uvec2 u = uvec2(ivec2(i) + 8192);
  return mix(mix(hash(u), hash(u + uvec2(1u, 0u)), f.x), mix(hash(u + uvec2(0u, 1u)), hash(u + uvec2(1u, 1u)), f.x), f.y);
}
// n octaves of nbN (at most 5), each turned and about twice as fine, half as strong; 0-1, around 0.5
float nbF(vec2 x, int n) {
  float s = 0.0, a = 0.5, t = 0.0;
  for (int i = 0; i < 5; i++) {
    if (i >= n) break;
    s += a * nbN(x); t += a;
    x = mat2(0.8, 0.6, -0.6, 0.8) * x * 2.03 + 11.7;
    a *= 0.5;
  }
  return s / t;
}
vec4 nebula(vec2 p) {
  vec4 a = uNb[0], b = uNb[1];
  vec2 d = p - a.xy;
  // outside its reach (a little over its long half-axis): nothing
  if (dot(d, d) > 1.3 * a.z * a.z) return vec4(0.0);
  vec2 u = vec2(dot(d, b.xy), dot(d, vec2(-b.y, b.x))) / a.z;
  u.y /= b.z;
  float r = length(u), tm = uNb[4].w * 0.01;
  vec2 x = u * 1.9 + b.w * 61.0;
  vec2 q = vec2(nbF(x + vec2(tm, 0.0), 3), nbF(x + vec2(5.2, 1.3 - tm), 3));
  vec2 w = vec2(nbF(x + 2.4 * q + vec2(1.7, 9.2), 3), nbF(x + 2.4 * q + vec2(8.3 + tm, 2.8), 3));
  float f = nbF(x * 1.1 + 2.6 * w, 5);
  float fl = 1.0 - abs(2.0 * nbF(x * 2.3 + 3.0 * w + 3.3, 4) - 1.0);
  fl *= fl * fl;
  float ln = nbF(x * 1.5 + 2.0 * w + 7.1, 3);
  float lane = exp(-pow((ln - 0.5) / 0.09, 2.0));
  // the ellipse's soft edge frayed by the density; the dust itself from the density's upper part, over a faint veil
  float env = smoothstep(0.0, 0.7, 1.0 - r + 0.55 * (f - 0.5));
  float dn = smoothstep(0.34, 0.74, f);
  float dens = env * (0.22 + 0.78 * dn) * (0.7 + 0.5 * fl) * (1.0 - 0.6 * lane);
  vec3 col = mix(uNb[2].rgb, uNb[3].rgb, clamp(0.3 + 1.3 * (w.x - 0.42), 0.0, 1.0));
  col = mix(col, uNb[3].rgb, fl * dn * 0.6);
  float rim = smoothstep(0.04, 0.3, env) * (1.0 - smoothstep(0.3, 0.75, env));
  col = mix(col, uNb[4].rgb, rim * 0.5);
  float al = a.w * dens;
  return vec4(col * al, al * ${glf(NEBULA_ALPHA)});
}`;
// the asteroid field (see "Look", ASTEROID_*), premultiplied, for one rock at device px p (a, b: its two vec4s in uAs, see
// SKY_U's comment; L: the light's direction, towards it). The rock lives in its own plane (middle, spin, long radius = 1,
// squashed by its aspect): its outline is that unit circle's radius bent by two noises over the angle (so it is lumpy and
// turns with the rock), the distance to it (in device px) gives the edge, soft by the blur (a sharp rock's is about a
// pixel). The surface is a sphere-like normal bumped by a noise's gradient and lit by L (a dark rock, mottled); the rim is
// the thin band just inside the edge, warm where the edge faces the light (broken up by a noise), with a cooler hint where
// it faces away. Dust: tiny soft specks, one at most in each cell of a grid laid on the rock, brighter on its lit side
// and fading out with the distance, drawn under it.
const ASTEROID_GLSL = `vec4 rock(vec2 p, vec4 a, vec4 b, vec2 L) {
  float bl = floor(b.w), seed = b.w - bl, R = a.z, dp = uSize.z;
  bool dusty = R > ${glf(ASTEROID_DUST_MIN)} * dp;
  vec2 d = p - a.xy;
  float reach = R * (dusty ? 3.3 : 1.5) + 2.5 * bl + 3.0 * dp;
  if (dot(d, d) > reach * reach) return vec4(0.0);
  vec2 u = vec2(dot(d, b.xy), dot(d, vec2(-b.y, b.x))) / R;
  u.y /= b.z;
  float rr = length(u);
  vec2 dir = u / max(rr, 1e-3);
  float lump = nbF(dir * 1.3 + seed * 53.0, 3) - 0.5, fine = nbF(dir * 3.4 + seed * 17.0 + 5.0, 2) - 0.5;
  float prof = 1.0 + 0.62 * lump + 0.2 * fine;
  float sc = R * length(vec2(dir.x, dir.y * b.z));
  float sd = (rr - prof) * sc;
  float w = max(0.8 * dp, bl);
  float cov = 1.0 - smoothstep(-w, w, sd);
  vec2 dn = d / max(length(d), 1e-3);
  vec4 o = vec4(0.0);
  if (cov > 0.002) {
    float soft = 1.0 - clamp(bl / (0.5 * R), 0.0, 0.6);
    vec2 g0 = u * 2.6 + seed * 91.0;
    float h = nbF(g0, 3);
    vec2 gr = vec2(nbF(g0 + vec2(0.07, 0.0), 3) - h, nbF(g0 + vec2(0.0, 0.07), 3) - h) / 0.07;
    vec2 gs = vec2(gr.x * b.x - gr.y * b.y, gr.x * b.y + gr.y * b.x);
    vec2 nn = d / max(sc * prof, 1.0);
    float nl = length(nn);
    vec3 N = normalize(vec3(nn - 0.3 * soft * gs, 0.8 * sqrt(max(1.0 - nl * nl, 0.02))));
    float diff = max(dot(N, normalize(vec3(L, 0.5))), 0.0);
    float mott = 1.0 + (0.72 + 0.56 * nbF(u * 5.2 + seed * 33.0, 3) - 1.0) * soft, far = bl > 0.5 ? 0.0 : 1.0;
    vec3 body = vec3(${ASTEROID_BODY.map(glf).join(', ')}) * mott * mix(0.22 + 0.5 * diff, 0.4 + 1.1 * diff, far) +
      vec3(${ASTEROID_RIM.map((v) => glf(v * 0.045)).join(', ')}) * diff * diff * far;
    float lit = smoothstep(-0.15, 0.9, dot(nl > 1e-3 ? nn / nl : dn, L));
    float rw = max(dp, 0.09 * R) * mix(0.55, 1.0, far) + 0.4 * bl, edge = exp(-pow(max(-sd, 0.0) / rw, 1.6));
    float brk = 0.6 + 0.8 * nbF(u * 7.0 + seed * 5.0, 2);
    float rimA = ${glf(ASTEROID_RIM_A)} * (bl > 0.5 ? ${glf(ASTEROID_CLOSE_RIM)} : 1.0);
    vec3 rim = vec3(${ASTEROID_RIM.map(glf).join(', ')}) * (rimA * pow(lit, 1.3) * edge * brk) + vec3(${ASTEROID_FILL.map(glf).join(', ')}) * (${glf(ASTEROID_FILL_A)} * pow(1.0 - lit, 2.0) * edge * (bl > 0.5 ? 0.5 : 1.0));
    o = vec4(body + rim, 1.0) * (cov * a.w);
  }
  if (dusty) {
    float cs = max(0.42 * R, 7.0 * dp), rn = length(d) / R;
    vec2 g = d / cs + seed * 91.0, id = floor(g), f = fract(g);
    uvec2 k = uvec2(ivec2(id) + 8192);
    float h1 = hash(k), h2 = hash(k + uvec2(17u, 91u)), h3 = hash(k + uvec2(53u, 7u)), h4 = hash(k + uvec2(5u, 211u));
    float sg = (0.55 + 0.35 * h4) * dp + 0.3 * bl;
    vec2 e = (f - vec2(0.3 + 0.4 * h2, 0.3 + 0.4 * h3)) * cs;
    float lit = 0.35 + 0.65 * smoothstep(-0.5, 1.0, dot(dn, L));
    float m = step(0.68, h1) * (1.0 - smoothstep(1.1, 3.2, rn)) * ${glf(ASTEROID_DUST_A)} * (0.35 + 0.65 * h4) * lit * a.w;
    m *= exp(-dot(e, e) / (sg * sg)) * min(1.0, 0.36 * dp * dp / (sg * sg));
    o += vec4(vec3(${ASTEROID_DUST.map(glf).join(', ')}) * m, m) * (1.0 - o.a);
  }
  return o;
}`;
// the gravity lens (see "Look", LENS_*), uLn (see SKY_U's comment). lensP: where the sky is looked up for the pixel at p: the
// point lens sends the light seen at d from its middle to the source at d - R^2 d / |d|^2 (R: the Einstein radius), a map with no
// tear in it, so a star near the ring is stretched round it and the tiles and cells it falls on are read as ever. The pull is
// eased out between LENS_FULL and LENS_REACH radii (a smooth window, so nothing ends in an edge) and kept off a pole at the
// middle, under the core. lensLight: the far galaxies' light at a lookup point b from the lens's middle (soft ellipses, each
// turned and squashed), which the pull sends into arcs; lensHole: the core in its shade, then the accretion ring (a Gaussian
// across with a fainter skirt, brighter towards one side), at p itself
const LENS_GLSL = `vec2 lensP(vec2 p) {
  vec4 a = uLn[0];
  if (a.w <= 0.0) return p;
  vec2 d = p - a.xy;
  float r2 = dot(d, d), R = a.z;
  if (r2 > ${glf(LENS_REACH * LENS_REACH)} * R * R) return p;
  float w = 1.0 - smoothstep(${glf(LENS_FULL)} * R, ${glf(LENS_REACH)} * R, sqrt(r2));
  return p - d * (w * R * R / max(r2, 0.0025 * R * R));
}
vec4 lensLight(vec2 b) {
  vec4 o = vec4(0.0);
  if (uLn[0].w <= 0.0 || dot(b, b) > 4.0 * uLn[0].z * uLn[0].z) return o;
  for (int i = 0; i < 2; i++) {
    vec4 s = uLn[1 + 2 * i], t = uLn[2 + 2 * i];
    if (s.w <= 0.0) continue;
    vec2 q = b - s.xy;
    q = vec2(dot(q, t.xy), dot(q, vec2(-t.y, t.x)));
    float m = s.w * exp(-(q.x * q.x + q.y * q.y / (t.z * t.z)) / (s.z * s.z));
    vec3 col = i == 0 ? vec3(${LENS_SRC[0].rgb.map(glf).join(', ')}) : vec3(${LENS_SRC[1].rgb.map(glf).join(', ')});
    o += vec4(col * m, m * ${glf(LENS_SRC_A)});
  }
  return o;
}
vec4 lensHole(vec2 p) {
  vec4 a = uLn[0];
  vec2 d = p - a.xy;
  float R = a.z, r = length(d), dp = uSize.z;
  if (a.w <= 0.0 || r > ${glf(LENS_SHADE)} * R + 8.0 * dp) return vec4(0.0);
  float core = 1.0 - smoothstep(${glf(LENS_CORE)} * R - dp, ${glf(LENS_CORE)} * R + dp, r);
  float shade = 1.0 - smoothstep(0.0, ${glf(LENS_SHADE)} * R, r);
  vec4 o = vec4(0.0, 0.0, 0.0, min(1.0, core + 0.5 * shade * shade) * ${glf(LENS_DARK)});
  float e = (r - ${glf(LENS_RING_R)} * R) / max(${glf(LENS_RING_W)} * dp, 0.02 * R);
  float side = 1.0 - ${glf(LENS_RING_SIDE)} + ${glf(LENS_RING_SIDE)} * (0.5 + 0.5 * cos(atan(d.y, d.x) - uLn[2].w));
  float m = ${glf(LENS_RING_A)} * side * (exp(-e * e) + 0.2 * exp(-e * e / 14.0));
  // after a meal it flares, whiter, and its skirt swells
  float fl = uLn[7].x;
  m *= 1.0 + ${glf(DEVOUR_RING)} * fl * (1.0 + 0.6 * exp(-e * e / 30.0));
  vec3 rc = mix(vec3(${LENS_RING_RGB.map(glf).join(', ')}), vec3(1.0, 0.97, 0.9), 0.5 * fl);
  return over(vec4(rc * min(m, 1.6), min(m, 1.6) * 0.5), o);
}
// the stream torn off the prey falling in (uLn[5], uLn[6]): a log spiral from the prey (rho, th) round to the ring, its angle at
// radius r th + w ln(rho / r), narrowing and hotter (whiter) inwards, its clumps flowing in along it; light, at p itself
vec4 lensFeed(vec2 p) {
  vec4 a = uLn[0], f = uLn[5], g = uLn[6];
  if (a.w <= 0.0 || g.w <= 0.0) return vec4(0.0);
  vec2 d = p - a.xy;
  float r = length(d), R = a.z, dp = uSize.z, r0 = ${glf(LENS_RING_R)} * R;
  if (r > f.x + 2.0 * f.w || r < 0.6 * r0) return vec4(0.0);
  float ts = f.y + f.z * log(f.x / max(r, 1.0));
  float da = atan(d.y, d.x) - ts;
  da = da - 6.2831853 * floor((da + 3.14159265) / 6.2831853);
  float u = clamp((r - r0) / max(f.x - r0, 1.0), 0.0, 1.0); // 1 at the prey, 0 at the ring
  float wd = max(f.w * (0.18 + 0.82 * u), 1.2 * dp), x = r * da / wd;
  if (abs(x) > 4.0) return vec4(0.0);
  float flow = nbF(vec2(log(max(r, 1.0)) * 14.0 + uLn[8].x * 2.5, x * 0.8 + 7.0), 3);
  float m = g.w * exp(-x * x) * (0.35 + 1.3 * flow * flow) * smoothstep(0.0, 0.08, u) * (1.0 - smoothstep(0.9, 1.05, u + 0.04 * abs(x)));
  m += 0.25 * g.w * exp(-x * x / 6.0) * (1.0 - u);
  vec3 col = mix(g.rgb, vec3(1.0, 0.95, 0.86), 0.75 * (1.0 - u));
  return vec4(col * m * (1.0 + 0.8 * (1.0 - u)), 0.5 * m);
}
// the jets after a meal (uLn[7]): two thin beams along the axis (y), out to jl, gone dark from the base out to jb, knots
// racing out along them; light, at p itself
vec4 lensJets(vec2 p) {
  vec4 a = uLn[0], j = uLn[7];
  if (a.w <= 0.0 || j.z <= 0.0) return vec4(0.0);
  vec2 d = p - a.xy, ax = vec2(cos(j.y), sin(j.y));
  float al = abs(dot(d, ax)), ac = dot(d, vec2(-ax.y, ax.x)), R = a.z, dp = uSize.z;
  if (al > j.z + R || al < j.w) return vec4(0.0);
  float wj = 0.05 * R + 0.07 * al + dp, x = ac / wj;
  if (abs(x) > 4.0) return vec4(0.0);
  float knots = 0.55 + 0.45 * sin(al / (0.35 * R) - uLn[8].x * 9.0) + 0.3 * nbF(vec2(al / (0.5 * R) - uLn[8].x * 3.0, x), 2);
  float m = ${glf(DEVOUR_JET_A)} * exp(-x * x) * knots * smoothstep(j.w, j.w + 0.3 * R, al) * (1.0 - smoothstep(0.7 * j.z, j.z, al)) * smoothstep(0.5 * R, 1.2 * R, al);
  vec3 col = mix(vec3(0.55, 0.72, 1.0), vec3(0.95, 0.97, 1.0), exp(-x * x * 3.0));
  return vec4(col * m, 0.5 * m);
}`;
// the distant capital ship (see "Look", SHIP_*), premultiplied, at device px p; uSh (see SKY_U's comment). shipOne draws one hull in
// its own frame (half-length = 1, x along its heading, y across with the top at negative y: the ship's lit side stays up on the
// screen when it goes left), shSD its signed distance (SHIP_HULL's polygons and SHIP_BOXES' boxes joined, SHIP_NOTCH's cut out; one
// function a polygon, from the table). The hull is nearly black and hides what is behind it. The rim light: the distance's gradient
// (four more lookups, only within a few px of the edge) is the surface's normal, so an edge facing the light (SHIP_LIGHT, turned
// into the ship's frame) gets a thin glow as bright as it faces, fading over about a px in and a little less out, varied along the
// ship by a slow noise, and a fainter, wider sheen into the hull below it, with a trace of bounce on the sides facing away. The
// windows: a few rows of cells, each lit or not by a hash of its cell and the ship's seed, drawn only where the cell is well inside
// the hull, a tiny soft point with a faint wider glow. The engines: a small glow at each nozzle with a short plume behind. The haze:
// the hull's colour mixed towards SHIP_HAZE (hz: more low on the hull, more on the escort, wp < 1), the rim and lights dimmed by
// 0.75 of that (lit; patches of mist fixed in the sky thin the hull and dim them further), the edges softened by SHIP_SOFT and a faint veil of haze just outside them
const SHIP_GLSL = (() => {
  const f2 = (v) => `vec2(${glf(v[0])}, ${glf(v[1])})`, f4 = (v) => `vec4(${v.map(glf).join(', ')})`;
  const polys = SHIP_HULL.map((pts, k) => `float shP${k}(vec2 p) {
  vec2 v[${pts.length}] = vec2[${pts.length}](${pts.map(f2).join(', ')});
  float d = dot(p - v[0], p - v[0]), s = 1.0;
  for (int i = 0; i < ${pts.length}; i++) {
    int j = i == 0 ? ${pts.length - 1} : i - 1;
    vec2 e = v[j] - v[i], w = p - v[i];
    vec2 b = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
    d = min(d, dot(b, b));
    bvec3 c = bvec3(p.y >= v[i].y, p.y < v[j].y, e.x * w.y > e.y * w.x);
    if (all(c) || all(not(c))) s = -s;
  }
  return s * sqrt(d);
}`).join('\n');
  const col = (v) => `vec3(${v.map(glf).join(', ')})`;
  const Ls = `vec2(${glf(SHIP_LIGHT[0])}, ${glf(SHIP_LIGHT[1])})`;
  return `${polys}
float shB(vec2 p, vec4 b) {
  vec2 q = abs(p - b.xy) - b.zw;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}
float shSD(vec2 q) {
  float d = min(shP0(q), min(shP1(q), shP2(q)));
${SHIP_BOXES.map((b) => `  d = min(d, shB(q, ${f4(b)}));`).join('\n')}
  float n = 1000.0;
${SHIP_NOTCH.map((b) => `  n = min(n, shB(q, ${f4(b)}));`).join('\n')}
  return max(d, -n);
}
const float SH_ROWS[${SHIP_ROWS.length}] = float[${SHIP_ROWS.length}](${SHIP_ROWS.map(glf).join(', ')});
const vec2 SH_ENG[${SHIP_ENGINES.length}] = vec2[${SHIP_ENGINES.length}](${SHIP_ENGINES.map(f2).join(', ')});
vec4 shipOne(vec2 p, vec2 c, float R, vec4 fr, float wp, float A, vec4 jp, float sm, vec4 xt) {
  vec2 d = p - c, e1 = fr.xy, e2 = vec2(-fr.y, fr.x);
  vec2 u = vec2(dot(d, e1), fr.z * dot(d, e2)) / R;
  // coming out of hyperspace: smeared back from the bow along its heading (sm: by that many of its lengths)
  u.x = ${glf(SHIP_BOW)} - (${glf(SHIP_BOW)} - u.x) / (1.0 + sm);
  if (u.x < -1.7 || u.x > 1.35 || abs(u.y) > 0.62) return vec4(0.0);
  float dp = uSize.z, w = (0.7 + (0.3 + ${glf(SHIP_SOFT)}) * dp) / R;
  // what is on the far side of the rift (jp: its middle, z 1: the hull shows ahead of it, -1: behind) is in hyperspace: not drawn
  if (jp.z != 0.0) A *= smoothstep(-dp, dp, jp.z * dot(p - jp.xy, e1));
  // xt: its side's tint (x, 1: the red side's), which half of a broken hull (y: 1 the bow's, -1 the stern's; 0 whole) and
  // where it broke (z, along it), and its heat (w, 0-1: burning, or falling into a black hole)
  float tear = 0.0;
  if (xt.y != 0.0) {
    float s = xt.y * (u.x - xt.z - 0.07 * (nbN(vec2(u.y * 26.0, fr.w * 40.0)) - 0.5) - 0.03 * (nbN(vec2(u.y * 90.0, 3.0)) - 0.5));
    A *= smoothstep(-w, w, s);
    tear = exp(-max(s, 0.0) / 0.035);
  }
  if (A <= 0.0) return vec4(0.0);
  float hot = xt.w > 0.0 ? 0.0 : sm / ${glf(SHIP_JUMP_STREAK)};
  vec3 tn = vec3(1.0, 0.5, 0.35);
  float sd = shSD(u), dd = sd * R;
  float cov = 1.0 - smoothstep(-w, w, sd);
  float plate = nbF(vec2(u.x * 36.0, u.y * 120.0) + fr.w * 71.0, 2);
  vec3 body = ${col(SHIP_BODY)} * (0.8 + 0.5 * plate) + ${col(SHIP_LIFT)} * smoothstep(0.12, -0.14, u.y);
  body = mix(body, ${col(SHIP_JUMP_RGB)} * 0.4, 0.7 * hot); // the blue it sheds as it slows
  float hz = min(${glf(SHIP_HAZE_MAX)}, ${glf(SHIP_HAZE_A)} * (1.0 + 0.35 * smoothstep(-0.05, 0.15, u.y)) * (wp < 1.0 ? 1.4 : 1.0));
  float mist = smoothstep(0.35, 0.7, nbF(p / (1.4 * R) + 3.1, 3));
  hz = min(0.97, hz + 0.1 * mist);
  body = mix(body, ${col(SHIP_HAZE)}, hz);
  float ba = cov * ${glf(SHIP_BODY_A)} * (1.0 - ${glf(SHIP_MIST)} * mist) * A, lit = A * (1.0 - 0.75 * hz) * (1.0 - 0.5 * mist);
  vec4 o = vec4(body * ba, ba);
  // still fast out of the rift: the hull glows the jump's blue-white through the haze, fading as it slows
  o.rgb += mix(${col(SHIP_JUMP_RGB)}, ${col(SHIP_JUMP_CORE)}, 0.5) * (${glf(SHIP_JUMP_GLOW)} * hot * hot * cov * A);
  if (dd > 0.0 && dd < 56.0 * dp) {
    float hg = ${glf(SHIP_HAZE_GLOW)} * exp(-dd / min(13.0 * dp, 0.13 * R)) * A;
    hg *= (1.0 - smoothstep(0.42, 0.62, abs(u.y))) * smoothstep(-1.7, -1.5, u.x) * (1.0 - smoothstep(1.15, 1.35, u.x));
    o = over(o, vec4(${col(SHIP_HAZE)} * 2.2 * hg, hg));
  }
  if (abs(dd) < 16.0 * dp) {
    float e = 1.6 / R;
    vec2 g = vec2(shSD(u + vec2(e, 0.0)) - shSD(u - vec2(e, 0.0)), shSD(u + vec2(0.0, e)) - shSD(u - vec2(0.0, e)));
    vec2 n = g / max(length(g), 1e-5);
    vec2 L = normalize(vec2(dot(${Ls}, e1), fr.z * dot(${Ls}, e2)));
    float fc = max(dot(n, L), 0.0), fb = max(-dot(n, L), 0.0);
    float vr = clamp(0.55 + 0.9 * nbF(u * 4.0 + fr.w * 30.0, 2), 0.4, 1.3);
    vec3 rc = mix(mix(${col(SHIP_RIM)}, ${col(SHIP_RIM_WARM)}, 0.6 * smoothstep(0.1, 1.0, u.x)), tn, 0.45 * xt.x);
    float edge = exp(min(dd, 0.0) / (1.1 * dp)) * exp(-pow(max(dd, 0.0) / (1.2 * dp), 2.0));
    float m = (${glf(SHIP_RIM_A)} * pow(fc, 1.3) * vr * edge + (dd < 0.0 ? 0.1 * fc * vr * exp(dd / (6.0 * dp)) : 0.0)) * lit;
    o = over(vec4(rc * m, m), o);
    float mb = 0.07 * fb * (dd < 0.0 ? exp(dd / (1.4 * dp)) : 0.0) * lit;
    o = over(vec4(vec3(0.45, 0.42, 0.66) * mb, mb), o);
  }
  // the windows
  for (int r = 0; r < ${SHIP_ROWS.length}; r++) {
    float ry = SH_ROWS[r];
    if (abs(u.y - ry) > 0.03 || sd > 0.0) continue;
    float cell = floor(u.x / 0.05), h = hash(uvec2(uint(int(cell) + 64), uint(r * 977 + int(fr.w * 65535.0))));
    if (h > ${glf(SHIP_WINDOW_P)} * wp * (r == 0 ? 3.0 : 1.0)) continue;
    vec2 wc = vec2((cell + 0.5) * 0.05, ry);
    if (shSD(wc) > -0.018) continue;
    vec2 q = (u - wc) * R;
    float rw = 0.62 * dp, q2 = dot(q, q);
    float m = ${glf(SHIP_WINDOW_A)} * (exp(-q2 / (rw * rw)) + 0.12 * exp(-q2 / (6.0 * rw * rw))) * lit;
    o = over(vec4(mix(${col(SHIP_WINDOW)}, tn, 0.5 * xt.x) * m, m), o);
  }
  // the engines
  for (int k = 0; k < ${SHIP_ENGINES.length}; k++) {
    vec2 q = (u - SH_ENG[k]) * R;
    float q2 = dot(q, q), rc = max(1.1 * dp, 0.011 * R), rh = 0.035 * R;
    float pl = q.x < 0.0 ? exp(q.x / (0.1 * R)) * exp(-pow(q.y / (0.012 * R + 0.5 * dp), 2.0)) : 0.0;
    float m = ${glf(SHIP_ENGINE_A)} * (exp(-q2 / (rc * rc)) + 0.28 * exp(-q2 / (rh * rh)) + 0.34 * pl) * lit;
    o = over(vec4(mix(${col(SHIP_ENGINE)}, tn, 0.7 * xt.x) * m, m), o);
  }
  // burning: ember patches that flicker over the hull, and the torn edge of a broken one glowing
  if (xt.w > 0.0 || tear > 0.0) {
    float fk = nbF(vec2(u.x * 9.0, u.y * 30.0) + fr.w * 40.0 + vec2(uSize.w * 0.7, -uSize.w * 0.4), 3);
    float em = (xt.w * smoothstep(0.62 - 0.3 * xt.w, 0.85, fk) + 0.9 * tear * (0.6 + 0.6 * fk)) * cov * A;
    vec3 ec = mix(vec3(1.0, 0.36, 0.08), vec3(1.0, 0.82, 0.5), smoothstep(0.7, 0.95, fk));
    o.rgb += ec * em * 0.9;
    o.a = min(1.0, o.a + 0.2 * em);
  }
  return o;
}
// the jump point (uSh[3], uSh[4]; h the heading): a churning blue cloud, a flattened oval across the path round a thin white
// slit, and the flash as the bow breaks out with its flare thrown ahead along the heading; light only (half its alpha hides)
vec4 shipJump(vec2 p, vec4 j, vec4 k, vec2 h) {
  float H = j.z, dp = uSize.z;
  vec2 d = p - j.xy;
  float r2 = dot(d, d) / (H * H);
  if (r2 > 16.0) return vec4(0.0);
  float a = dot(d, h), c = dot(d, vec2(-h.y, h.x));
  vec2 q = vec2(a / (0.62 * H), c / (1.05 * H));
  float sw = nbF(vec2(a, c) / (0.28 * H) + vec2(k.w * 0.9, -k.w * 0.6), 3);
  float cl = exp(-1.3 * dot(q, q)) * (0.2 + 1.3 * sw * sw);
  vec2 qc = vec2(a / (0.07 * H + 0.8 * dp), c / (0.9 * H));
  float co = 0.75 * exp(-2.5 * dot(qc, qc));
  float fl = k.x * (exp(-1.6 * r2) + (a > 0.0 ? 0.55 * exp(-a / (1.8 * H)) * exp(-pow(c / (0.1 * H + 0.1 * a), 2.0)) : 0.0));
  vec3 L = (${col(SHIP_JUMP_RGB)} * cl * 1.1 + ${col(SHIP_JUMP_CORE)} * co) * j.w * ${glf(SHIP_JUMP_A)} + ${col(SHIP_JUMP_CORE)} * fl;
  return vec4(L, 0.5 * max(L.r, max(L.g, L.b)));
}
// the ship and its escort far off, so bent by a black hole between (drawn at pl, where the sky is looked up), unless it is
// falling into one (uSh[5].y: how far off its course, so drawn where it is); uSh[5].x its heat
vec4 ship(vec2 p0, vec2 pl) {
  vec4 a = uSh[0], f = uSh[1], e = uSh[2], j = uSh[3], k = uSh[4], h = uSh[5];
  if (a.w <= 0.0) return vec4(0.0);
  vec2 p = mix(pl, p0, h.y), d = p - a.xy;
  vec4 o = vec4(0.0), xt = vec4(0.0, 0.0, 0.0, h.x);
  float reach = a.z * (e.z > 0.0 ? 2.9 : 1.7) * (1.0 + k.y);
  if (dot(d, d) <= reach * reach) {
    vec4 jp = vec4(j.xy, k.z, 0.0);
    o = shipOne(p, a.xy, a.z, f, 1.0, a.w, jp, k.y, xt);
    if (e.z > 0.0) {
      vec2 c2 = a.xy + a.z * (e.x * f.xy + e.y * f.z * vec2(-f.y, f.x));
      o = over(o, shipOne(p, c2, a.z * e.z, vec4(f.xyz, e.w), 0.34, a.w, jp, k.y, xt));
    }
  }
  if (j.w > 0.0 || k.x > 0.0) o = over(shipJump(p, j, k, f.xy), o);
  return o;
}`;
})();
// the planet (see "Look", PLANET_*), premultiplied; uPl: [0] its middle (device px; x, y), radius (device px) and alpha (w; 0:
// none), [1] its star's direction turned into its axis's roll (x, y; z towards us) and kind (w), [2] the roll's cos and sin, its
// turn (radians) and seed, [3] its air's colour and thickness (w, in its radius), [4] its first colour and how open we see its
// equator (w: the sine of our height over it), [5] its second colour and its clouds' turn (w), [6] the tide (x, y: the unit way
// to a black hole eating it), its stretch (z, 1: none) and heat (w), [7] its moon's place round it (x, y, in its radii, rolled)
// and radius (z; 0: none), in front (w 1) or behind (-1), [8] its rings' inner and outer radius (0: none) and how far it is
// off its course into a black hole (z: drawn at p then, not bent). The surface: a point on the sphere (N, rolled; z towards us)
// taken into its own frame (round its axis, x and y; up it, z) and turned by its spin, then a 3D value noise (pnF) there, so
// nothing seams: gas giants in bands warped by the noise with a storm oval, ocean worlds with land, ice caps, clouds turning on
// their own, the sea's glint and cities on the night side, ice giants in soft bands with a dark spot, haze worlds nearly
// featureless, rust deserts with white poles. Lit by its star with a soft, reddened terminator (softer for thick air), a rim of
// its air on the disc and a halo off it (brighter towards the star; all round when the star is behind), its rings (a gap, the
// planet's shadow on them; their far half under the disc, the near one over), then the far haze over all (PLANET_HAZE)
const PLANET_GLSL = (() => {
  const col = (v) => `vec3(${v.map(glf).join(', ')})`;
  return `float pnH(uvec3 u) { return hash(uvec2(u.x * 7919u + u.z * 104729u, u.y)); }
float pnN(vec3 x) {
  vec3 i = floor(x), f = x - i;
  f = f * f * (3.0 - 2.0 * f);
  uvec3 u = uvec3(ivec3(i) + 4096);
  float a = mix(pnH(u), pnH(u + uvec3(1u, 0u, 0u)), f.x), b = mix(pnH(u + uvec3(0u, 1u, 0u)), pnH(u + uvec3(1u, 1u, 0u)), f.x);
  float c = mix(pnH(u + uvec3(0u, 0u, 1u)), pnH(u + uvec3(1u, 0u, 1u)), f.x), e = mix(pnH(u + uvec3(0u, 1u, 1u)), pnH(u + uvec3(1u, 1u, 1u)), f.x);
  return mix(mix(a, b, f.y), mix(c, e, f.y), f.z);
}
// n octaves of pnN (at most 5), each about twice as fine, half as strong; 0-1, around 0.5
float pnF(vec3 x, int n) {
  float s = 0.0, a = 0.5, t = 0.0;
  for (int i = 0; i < n; i++) {
    s += a * pnN(x); t += a;
    x = x * 2.07 + vec3(5.3, 1.7, 9.1);
    a *= 0.5;
  }
  return s / max(t, 1e-3);
}
float wrapA(float a) { return a - 6.2831853 * floor((a + 3.14159265) / 6.2831853); }
vec4 planetMoon(vec2 v, vec4 mo, vec3 L, float aa) {
  vec2 q = (v - mo.xy) / mo.z;
  float r2 = dot(q, q);
  if (r2 > 1.3) return vec4(0.0);
  vec3 N = vec3(q / max(1.0, sqrt(r2)), sqrt(max(1.0 - r2, 0.0)));
  float cov = 1.0 - smoothstep(1.0 - aa / mo.z, 1.0 + aa / mo.z, sqrt(r2));
  float sp = pnF(N * 3.0 + 11.0, 3);
  vec3 c = vec3(0.62, 0.6, 0.58) * (0.7 + 0.5 * sp) * (0.03 + max(dot(N, L), 0.0)) * ${glf(PLANET_LIGHT * 1.4)};
  c = mix(c, ${col(SHIP_HAZE)}, ${glf(PLANET_HAZE)});
  return vec4(c * cov, cov);
}
// its rings at v (rolled, in its radii), the half towards us (side 1) or away (-1)
vec4 planetRing(vec2 v, vec2 rg, float op, float co, vec3 L, vec3 tint, float aa, float seed, float side) {
  if (rg.y <= 0.0 || abs(op) < 1e-3) return vec4(0.0);
  float yy = v.y / op, rr = length(vec2(v.x, yy));
  if (rr < rg.x - 0.05 || rr > rg.y + 0.05 || yy * side < 0.0) return vec4(0.0);
  float u = (rr - rg.x) / (rg.y - rg.x), ea = aa / max(abs(op), 0.08);
  float dens = smoothstep(0.0, ea + 0.01, u) * (1.0 - smoothstep(1.0 - ea - 0.02, 1.0, u));
  dens *= (0.4 + 0.6 * pnN(vec3(rr * 55.0, seed * 37.0, 0.5))) * (0.75 + 0.25 * sin(rr * 23.0 + seed * 9.0));
  dens *= (1.0 - 0.92 * exp(-pow((u - 0.62) / 0.025, 2.0))) * (0.7 + 0.3 * smoothstep(0.0, 0.5, u));
  // the planet's shadow across them: the way to the star from the ring's point passes through the sphere
  vec3 X = vec3(v.x, v.y, co * yy);
  float b = dot(X, L), c = dot(X, X) - 1.0;
  float sh = b < 0.0 ? smoothstep(-0.04, 0.04, c - b * b) : 1.0;
  float face = dot(L, vec3(0.0, -co, op)) * sign(op);
  float lit = (face > 0.0 ? 0.3 + 0.9 * face : 0.3 * (1.0 - face)) * (0.2 + 0.8 * sh);
  float A = (1.0 - exp(-dens * 0.35 / max(abs(op), 0.05))) * 0.9;
  vec3 col = mix(mix(tint, vec3(0.95, 0.9, 0.82), 0.4) * lit * ${glf(PLANET_LIGHT * 1.3)} + 0.02, ${col(SHIP_HAZE)}, ${glf(PLANET_HAZE)});
  return vec4(col * A, A);
}
vec4 planet(vec2 p0, vec2 pl) {
  vec4 a = uPl[0];
  if (a.w <= 0.0 || a.z <= 0.0) return vec4(0.0);
  vec4 Lk = uPl[1], tr = uPl[2], air = uPl[3], cA = uPl[4], cB = uPl[5], td = uPl[6], mo = uPl[7], rg = uPl[8];
  vec2 p = mix(pl, p0, rg.z), d = (p - a.xy) / a.z;
  // the tide: stretched along the way to the hole, squeezed across it
  if (td.z > 1.0) { vec2 t = td.xy, n = vec2(-t.y, t.x); d = t * (dot(d, t) / td.z) + n * (dot(d, n) * sqrt(td.z)); }
  float th = air.w, reach = max(1.0 + 5.0 * th + 0.25, max(rg.y + 0.1, mo.z > 0.0 ? length(mo.xy) + mo.z + 0.1 : 0.0));
  if (dot(d, d) > reach * reach) return vec4(0.0);
  vec2 v = vec2(d.x * tr.x + d.y * tr.y, -d.x * tr.y + d.y * tr.x); // rolled to its axis
  vec3 L = normalize(Lk.xyz + vec3(0.0, 0.0, 1e-4));
  float aa = 1.2 * uSize.z / a.z, r = length(v), kind = Lk.w;
  float op = cA.w, co = sqrt(max(1.0 - op * op, 0.0));
  vec3 Ax = vec3(0.0, -co, op), E2 = vec3(0.0, op, co);
  vec4 o = vec4(0.0);
  if (mo.z > 0.0 && mo.w < 0.0) o = planetMoon(v, mo, L, aa);
  vec3 tint = mix(cA.rgb, cB.rgb, 0.3);
  o = over(planetRing(v, rg.xy, op, co, L, tint, aa, tr.w, -1.0), o);
  // the halo: its air lit off the disc, towards the star, and all round when the star is behind it
  if (r > 1.0 - aa) {
    float tw = dot(v / max(r, 1e-4), L.xy);
    float hl = smoothstep(-0.7, 0.7, tw + 0.6 * L.z) * (0.35 + 0.65 * length(L.xy)) + 1.2 * max(-L.z, 0.0) * (0.6 + 0.4 * smoothstep(-0.5, 0.5, tw));
    float h = ${glf(PLANET_GLOW)} * hl * exp(-max(r - 1.0, 0.0) / (max(th, 0.03) * 1.15)) * min(1.0, th * 12.0 + 0.3) * smoothstep(1.0 - aa, 1.0 + aa, r);
    o = over(vec4(mix(air.rgb, vec3(1.0), 0.15 * max(-L.z, 0.0)) * h, 0.35 * h), o);
  }
  if (r < 1.0 + aa) {
    vec2 vv = v / max(r, 1.0);
    float z = sqrt(max(1.0 - dot(vv, vv), 0.0)), cov = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r);
    vec3 N = vec3(vv, z);
    float lam = dot(N, L), sl = dot(N, Ax), lat = asin(clamp(sl, -1.0, 1.0));
    vec3 P = vec3(N.x, dot(N, E2), sl); // round its equator (x, y), up its axis (z)
    // its spin (a gas or ice giant's equator turns a little faster), and its clouds' own
    float sp = tr.z * (kind < 0.5 || (kind > 1.5 && kind < 2.5) ? 1.0 + 0.12 * cos(2.0 * lat) : 1.0), cs = cB.w;
    vec3 Ps = vec3(P.x * cos(sp) - P.y * sin(sp), P.x * sin(sp) + P.y * cos(sp), P.z);
    vec3 Pc = vec3(P.x * cos(cs) - P.y * sin(cs), P.x * sin(cs) + P.y * cos(cs), P.z);
    vec3 sd = vec3(53.0, 17.0, 31.0) * tr.w;
    float lon = atan(Ps.y, Ps.x), gloss = 0.0;
    vec3 col, night = vec3(0.0);
    if (kind < 0.5) {
      // a gas giant: zones and belts, warped and streaked, and its great storm
      float w = pnF(Ps * 2.5 + sd, 4), fine = pnF(vec3(Ps.xy * 1.5, sl * 40.0) + sd, 3);
      float bands = 0.5 + 0.5 * sin(sl * 15.0 + (w - 0.5) * 4.5 + tr.w * 6.0);
      col = mix(cA.rgb, cB.rgb, clamp(smoothstep(0.25, 0.75, bands) * (0.7 + 0.8 * (fine - 0.5)), 0.0, 1.0));
      vec2 so = vec2(wrapA(lon - 0.6 - tr.w * 6.0) * cos(lat) / 0.2, (lat + 0.36) / 0.085);
      float st = exp(-dot(so, so));
      col = mix(col, vec3(0.8, 0.38, 0.24), 0.8 * st * (0.75 + 0.5 * (fine - 0.5)));
    } else if (kind < 1.5) {
      // an ocean world: seas, land, ice caps, clouds, the sea's glint and cities at night
      float h = pnF(Ps * 2.2 + sd, 5), land = smoothstep(0.53, 0.57, h);
      col = mix(cA.rgb * (0.8 + 0.4 * pnF(Ps * 6.0 + sd, 2)), mix(cB.rgb, vec3(0.55, 0.45, 0.3), smoothstep(0.6, 0.72, h)), land);
      float ice = smoothstep(0.8, 0.87, abs(sl) + 0.1 * (h - 0.5));
      col = mix(col, vec3(0.92, 0.95, 1.0), ice);
      float cl = smoothstep(0.5, 0.72, pnF(Pc * 3.0 + sd + 4.0, 4));
      col = mix(col, vec3(0.96), 0.85 * cl);
      gloss = (1.0 - land) * (1.0 - ice) * (1.0 - cl);
      night = vec3(1.0, 0.68, 0.32) * 0.55 * smoothstep(0.7, 0.8, pnN(Ps * 70.0 + sd)) * land * (1.0 - ice) * (1.0 - 0.85 * cl);
    } else if (kind < 2.5) {
      // an ice giant: soft bands, a dark spot and bright streaks of cloud
      float w = pnF(Ps * 2.0 + sd, 3);
      col = mix(cA.rgb, cB.rgb, 0.55 * (0.5 + 0.5 * sin(sl * 9.0 + (w - 0.5) * 2.0)));
      vec2 so = vec2(wrapA(lon + 1.1 - tr.w * 6.0) * cos(lat) / 0.17, (lat - 0.32) / 0.08);
      col = mix(col, cB.rgb * 0.4, 0.75 * exp(-dot(so, so)));
      col = mix(col, vec3(0.9, 0.97, 1.0), 0.6 * smoothstep(0.64, 0.8, pnF(vec3(Pc.xy * 3.0, sl * 30.0) + sd, 3)) * exp(-pow((sl - 0.42) / 0.06, 2.0)));
    } else if (kind < 3.5) {
      // a haze world: all but featureless, faint bands in its smog
      float w = pnF(Pc * 1.6 + sd, 4);
      col = mix(cA.rgb, cB.rgb, 0.35 * (0.5 + 0.5 * sin(sl * 6.0 + w * 3.0)) + 0.25 * w);
    } else {
      // a rust desert: dunes and craters, white poles
      float h = pnF(Ps * 3.0 + sd, 5), cr = pnF(Ps * 9.0 + sd + 2.0, 3);
      col = mix(cB.rgb, cA.rgb, smoothstep(0.35, 0.65, h)) * (0.85 + 0.3 * cr);
      col = mix(col, vec3(0.95, 0.93, 0.9), smoothstep(0.86, 0.92, abs(sl) + 0.1 * (h - 0.5)));
    }
    // its star: a terminator as soft as its air is thick, reddened at dusk; its limb darker; the sea's glint
    float day = smoothstep(-0.05 - 1.5 * th, 0.1 + th, lam), dusk = exp(-pow(lam / (0.12 + th), 2.0));
    vec3 lc = col * day * mix(vec3(1.0), vec3(1.0, 0.52, 0.3), 0.6 * dusk) * mix(0.55, 1.0, sqrt(z));
    lc += gloss * pow(max(dot(N, normalize(L + vec3(0.0, 0.0, 1.0))), 0.0), 60.0) * vec3(1.0, 0.92, 0.8) * step(0.0, lam);
    lc = lc * ${glf(PLANET_LIGHT)} + col * 0.02 + night * (1.0 - smoothstep(-0.15, 0.05, lam));
    // its air at the rim of the disc, brighter on the lit side
    lc += air.rgb * pow(1.0 - z, 2.5) * (0.9 * smoothstep(-0.35, 0.4, lam) + 0.3 * max(-L.z, 0.0)) * min(1.0, th * 14.0) * ${glf(PLANET_LIGHT * 1.6)};
    // falling into a black hole: the side towards it glows, flickering
    if (td.w > 0.0) {
      vec2 tv = vec2(td.x * tr.x + td.y * tr.y, -td.x * tr.y + td.y * tr.x);
      float fk = pnF(Ps * 5.0 + vec3(uSize.w * 0.5, 0.0, 0.0), 3);
      lc += vec3(1.0, 0.4, 0.12) * td.w * (0.25 + 0.9 * smoothstep(-0.3, 0.9, dot(vv, tv))) * (0.4 + 0.9 * fk);
    }
    lc = mix(lc, ${col(SHIP_HAZE)}, ${glf(PLANET_HAZE)});
    float A = cov * ${glf(PLANET_A)};
    o = over(vec4(lc * A, A), o);
  }
  o = over(planetRing(v, rg.xy, op, co, L, tint, aa, tr.w, 1.0), o);
  if (mo.z > 0.0 && mo.w > 0.0) o = over(planetMoon(v, mo, L, aa), o);
  return o * a.w;
}`;
})();
// the space battle (see "Look", BATTLE_*), premultiplied; uBt: [0] its middle (device px; x, y) and reach (z, device px; 0:
// none), [1] how many hulls, streaks and blasts (x, y, z) and its clock (w, s); then BATTLE_HULLS hulls, five each: middle,
// half-length (device px) and alpha, heading's cos and sin, flip and seed, its rift (middle, half-height, alpha), the flash, its
// smear, which side of the rift it shows on (1 ahead, -1 behind, 0 none) and the rift's clock, then its side, half, cut and heat
// (shipOne's xt); then BATTLE_STREAKS streaks, two each: head and tail (device px), colour and alpha + 2 x its type (0 a bolt, 1
// a fighter, 2 a torpedo, 3 a tracer); then BATTLE_BLASTS blasts, two each: middle, size (device px) and alpha, age (s), seed,
// kind (0 a hit, 1 a shield's ripple, 2 an explosion, 3 a capital ship blowing apart, 4 a fire, 5 flak, 6 a fighter lost, 7 a
// wreck's last burst) and side. The loops run to counts the compiler can't know, so it keeps one copy of each (not unrolled)
const BATTLE_GLSL = (() => {
  const col = (v) => `vec3(${v.map(glf).join(', ')})`;
  const S = 2 + BATTLE_HULLS * 5, B = S + BATTLE_STREAKS * 2;
  return `vec3 btSide(float s) { return s < 0.5 ? ${col(BATTLE_SIDES[0])} : ${col(BATTLE_SIDES[1])}; }
// the squared distance from p to the segment a-b, and t: how far along it (0 at a, 1 at b)
float btSeg(vec2 p, vec2 a, vec2 b, out float t) {
  vec2 e = b - a;
  t = clamp(dot(p - a, e) / max(dot(e, e), 1e-4), 0.0, 1.0);
  vec2 q = p - a - e * t;
  return dot(q, q);
}
vec4 btStreak(vec2 p, vec4 s, vec4 c, float dp) {
  float ty = floor(c.w * 0.5), al = c.w - 2.0 * ty, t;
  float d2 = btSeg(p, s.zw, s.xy, t) / (dp * dp);
  if (d2 > 200.0) return vec4(0.0);
  vec2 qh = (p - s.xy) / dp;
  float h2 = dot(qh, qh), m;
  vec3 col = c.rgb;
  if (ty < 0.5) {
    // a bolt: a hot core, brightest at its head, in a glow of its side's colour
    m = al * t * (exp(-d2 / 0.45) + 0.22 * exp(-d2 / 6.0));
    col = mix(c.rgb, vec3(1.0), 0.55 * exp(-d2 / 0.3));
  } else if (ty < 1.5) {
    // a fighter: a speck, its engine's short trail
    m = al * (0.9 * exp(-h2 / 0.6) + 0.35 * t * t * exp(-d2 / 0.35));
    col = mix(vec3(0.85), c.rgb, 0.7);
  } else if (ty < 2.5) {
    // a torpedo: a bright head, pulsing, and a soft trail
    float pu = 0.75 + 0.25 * sin(uBt[1].w * 31.0 + s.x * 0.37);
    m = al * (pu * (exp(-h2 / 1.4) + 0.3 * exp(-h2 / 14.0)) + 0.4 * t * exp(-d2 / 1.1));
    col = mix(c.rgb, vec3(1.0), 0.5 * exp(-h2 / 0.8));
  } else {
    // a tracer
    m = al * t * exp(-d2 / 0.3);
  }
  return vec4(col * m, 0.5 * m);
}
vec4 btBlast(vec2 p, vec4 b, vec4 c) {
  float R = max(b.z, 0.5), dp = uSize.z, age = c.x, kind = c.z;
  vec2 d = p - b.xy;
  float r = length(d);
  if (r > R * (kind > 2.5 && kind < 3.5 ? 8.6 : 5.6) + 6.0 * dp) return vec4(0.0);
  float fbR = 0.0, T = 0.0, fbA = 0.0, ringR = 0.0, ringA = 0.0, flash = 0.0, sv = 0.0, g = 1.0 - exp(-age / 0.12);
  int sn = 0;
  if (kind < 0.5) { fbR = 0.5 + 0.5 * g; T = exp(-age / 0.15); fbA = pow(max(1.0 - age / 0.45, 0.0), 2.0); flash = exp(-age / 0.06); sn = 5; sv = 2.2; }
  else if (kind < 1.5) { ringR = 0.35 + 1.3 * age / 0.7; ringA = 0.9 * pow(max(1.0 - age / 0.7, 0.0), 2.0); flash = 0.5 * exp(-age / 0.08); }
  else if (kind < 2.5) { fbR = 0.5 + 1.1 * (1.0 - exp(-age / 0.35)); T = exp(-age / 0.55); fbA = pow(max(1.0 - age / 1.8, 0.0), 1.5); flash = 1.4 * exp(-age / 0.1); sn = 10; sv = 3.0; }
  else if (kind < 3.5) { fbR = 0.6 + 1.8 * (1.0 - exp(-age / 1.2)); T = exp(-age / 1.6); fbA = pow(max(1.0 - age / 6.5, 0.0), 1.5);
    ringR = 0.8 + 7.0 * (1.0 - exp(-age / 1.5)); ringA = 0.8 * exp(-age / 1.8); flash = 1.1 * exp(-age / 0.2); sn = 24; sv = 6.0; }
  else if (kind < 4.5) { float fk = nbN(vec2(age * 9.0, c.y * 50.0)); fbR = 0.55 + 0.15 * fk; T = 0.5 + 0.3 * fk; fbA = b.w * (0.55 + 0.45 * fk); }
  else if (kind < 5.5) { fbR = 0.4 + 0.6 * g; T = exp(-age / 0.15); fbA = pow(max(1.0 - age / 0.6, 0.0), 2.0); flash = 0.8 * exp(-age / 0.06); sn = 6; sv = 1.8; }
  else if (kind < 6.5) { fbR = 0.5 + 0.9 * g; T = exp(-age / 0.25); fbA = pow(max(1.0 - age / 0.9, 0.0), 2.0); flash = exp(-age / 0.07); sn = 8; sv = 2.5; }
  else { fbR = 0.6 + 1.4 * (1.0 - exp(-age / 0.6)); T = exp(-age / 0.9); fbA = pow(max(1.0 - age / 6.0, 0.0), 1.5);
    ringR = 0.6 + 3.5 * (1.0 - exp(-age / 0.8)); ringA = 0.5 * exp(-age / 0.9); flash = 1.5 * exp(-age / 0.12); sn = 16; sv = 4.0; }
  vec3 sc = btSide(c.w);
  vec4 o = vec4(0.0);
  // the fireball: churning, white-hot to deep red as it cools, and the smoke it leaves
  if (fbA > 0.0 && r < 1.6 * R * fbR) {
    float q = r / (R * fbR), tu = nbF(d / (0.35 * R * fbR) + c.y * 40.0 + vec2(age * 0.9, -age * 0.6), 3), edge = 0.75 + 0.5 * tu;
    float dens = 1.0 - smoothstep(edge - 0.35, edge, q), heat = T * (1.0 - 0.6 * q) * (0.6 + 0.8 * tu);
    vec3 fc = mix(vec3(0.45, 0.07, 0.02), vec3(1.0, 0.5, 0.12), smoothstep(0.1, 0.45, heat));
    fc = mix(fc, vec3(1.0, 0.93, 0.78), smoothstep(0.5, 0.9, heat));
    float e = dens * fbA * smoothstep(0.02, 0.2, heat), sa = 0.55 * dens * fbA * (1.0 - T);
    o = over(vec4(fc * e * 1.3, 0.6 * e), vec4(vec3(0.04) * sa, sa));
  }
  // the shock ring (a shield's ripple in its side's colour)
  if (ringA > 0.0) {
    float x = (r - ringR * R) / (0.12 * R + 1.5 * dp);
    float m = ringA * exp(-x * x) * (0.65 + 0.5 * nbF(d / (0.4 * R) + c.y * 20.0, 2));
    vec3 rc = kind > 0.5 && kind < 1.5 ? mix(sc, vec3(1.0), 0.25) : vec3(1.0, 0.82, 0.62);
    o = over(vec4(rc * m, 0.5 * m), o);
  }
  if (flash > 0.0) {
    float fr = R * (kind > 2.5 && kind < 3.5 ? 1.6 : 1.0), m = flash * exp(-r * r / (fr * fr));
    o = over(vec4((kind > 0.5 && kind < 1.5 ? sc : vec3(1.0, 0.95, 0.85)) * m, 0.5 * min(m, 1.0)), o);
  }
  // sparks flung out, each a short streak, cooling as it flies
  uint sd = uint(c.y * 65535.0);
  for (int k = 0; k < sn; k++) {
    float h1 = hash(uvec2(uint(k) + 101u, sd)), h2 = hash(uvec2(uint(k) + 7u, sd + 3u));
    float an = h1 * 6.2831853, spd = sv * (0.4 + 0.8 * h2), t;
    vec2 dir = vec2(cos(an), sin(an)), hd = b.xy + dir * R * spd * (1.0 - exp(-age / 0.7));
    float d2 = btSeg(p, hd - dir * (R * 0.25 * spd * exp(-age / 0.5) + dp), hd, t) / (dp * dp);
    if (d2 > 30.0) continue;
    float m = exp(-age / (0.5 + 1.2 * h2 * (kind > 2.5 ? 2.0 : 1.0))) * t * exp(-d2 / 0.5);
    o = over(vec4(mix(vec3(1.0, 0.55, 0.2), vec3(1.0, 0.95, 0.8), exp(-age / 0.3)) * m, 0.5 * m), o);
  }
  return o * 0.88; // far off: a little dimmed by the haze
}
vec4 battle(vec2 p) {
  vec4 a = uBt[0], n = uBt[1];
  vec2 d = p - a.xy;
  if (a.z <= 0.0 || dot(d, d) > a.z * a.z) return vec4(0.0);
  vec4 o = vec4(0.0);
  float dp = uSize.z;
  int nh = int(n.x), ns = int(n.y), nb = int(n.z);
  for (int i = 0; i < nh; i++) {
    int b = 2 + 5 * i;
    vec4 h0 = uBt[b], h1 = uBt[b + 1], h2 = uBt[b + 2], h3 = uBt[b + 3], h4 = uBt[b + 4];
    vec2 dh = p - h0.xy;
    float rr = h0.z * 1.8 * (1.0 + h3.y);
    if (dot(dh, dh) < rr * rr) o = over(shipOne(p, h0.xy, h0.z, h1, 1.0, h0.w, vec4(h2.xy, h3.z, 0.0), h3.y, h4), o);
    if (h2.w > 0.0 || h3.x > 0.0) o = over(shipJump(p, h2, h3, h1.xy), o);
  }
  for (int i = 0; i < nb; i++) o = over(btBlast(p, uBt[${B} + 2 * i], uBt[${B + 1} + 2 * i]), o);
  for (int i = 0; i < ns; i++) o = over(btStreak(p, uBt[${S} + 2 * i], uBt[${S + 1} + 2 * i], dp), o);
  return o;
}`;
})();
// per device pixel, premultiplied: the tint (mixed top to bottom unpremultiplied, as a canvas gradient mixes) over the
// page's colour, the deep sky's light and its star dust (dense where the band is) over that, then each star layer,
// back to front (STAR_GLSL), sampled where the pixel's centre falls on its tile or made there, the satellites, the shooting
// star and the moon; then the vignette
// (black, so in glass it dims the acrylic a little too), the repo glows ('screen': 1 - (1 - sky)(1 - glow), on colour and alpha alike, as the canvas does) and
// a dither fixed to the pixel (never to time) that breaks the faint gradients' 8-bit bands
const SKY_FS = `#version 300 es
precision highp float;
#define GLOW_MAX ${GLOW_MAX}
#define METEOR_N ${METEOR_N}
#define SAT_N ${SAT_N}
#define ROCKET_N ${ROCKET_N}
#define ASTEROID_N ${ASTEROID_N}
#define FAR_N ${FAR_N}
uniform vec4 uSize, uBg, uTop, uBot, uL0, uL1, uL2, uD, uDu, uFx, uMo, uOrg, uGlow, uN0, uN1;
uniform vec4 uM[METEOR_N], uMc[METEOR_N], uSat[SAT_N], uSac[SAT_N], uRk[ROCKET_N], uRp[ROCKET_N], uRw[ROCKET_N], uNb[5], uAs[ASTEROID_N * 2 + 1], uLn[9], uSh[6], uWp[2], uFr[FAR_N * 4], uPl[9], uBt[${SKY_BT_N}];
uniform vec4 uGB[GLOW_MAX], uGE[GLOW_MAX], uGC[GLOW_MAX], uGL[GLOW_MAX];
uniform int uGN, uFrN;
uniform sampler2D ${SKY_TEX.join(', ')};
out vec4 color;
${STAR_FIELD_GLSL}
vec4 over(vec4 a, vec4 b) { return a + b * (1.0 - a.a); }
vec4 star(sampler2D s, vec4 l, vec2 p) { return texture(s, (p - l.xy) * l.z); }
float hash(uvec2 v) {
  uint h = v.x * 0x8da6b343u ^ v.y * 0xd8163841u;
  h ^= h >> 15; h *= 0x2c1b3c6du; h ^= h >> 12; h *= 0x297a2d39u; h ^= h >> 15;
  return float(h) / 4294967295.0;
}
${NEBULA_GLSL}
${ASTEROID_GLSL}
${LENS_GLSL}
${SHIP_GLSL}
${PLANET_GLSL}
${BATTLE_GLSL}
${WARP_GLSL}
${FAR_GLSL}
void main() {
  vec2 p = vec2(gl_FragCoord.x, uSize.y - gl_FragCoord.y); // the pixel's centre, device px from the top left
  vec4 t = mix(uTop, uBot, p.y / uSize.y);
  vec4 c = over(vec4(t.rgb * t.a, t.a), uBg);
  vec2 pl = lensP(p); // where the sky under the satellites is looked up (the gravity lens bends it; p without one)
  vec2 pw = warpP(pl, uWp[1].z); // the deep sky's lookup, stretched a little by the warp drift
  vec4 d = texture(uDeep, (pw - uD.xy) * uD.zw);
  vec3 g = d.rgb * uFx.y;
  c = over(vec4(g, max(g.r, max(g.g, g.b))), c);
  c = over(vec4(texture(uDust, (pw - uDu.xy) * uDu.z).r * d.a * uFx.z), c);
  // the nebula drift, over the deep sky and under the stars, which show through it
  if (uNb[0].w > 0.0) c = over(nebula(pl), c);
  // the far event's parts (supernovae, mergers, bursts...), far away, under the stars: uFrN of them, a count the compiler
  // can't know, so it keeps farPart once in a real loop instead of unrolling it FAR_N times (D3D11 took minutes longer)
  for (int i = 0; i < uFrN; i++) c = over(farPart(pl, uFr[i * 4], uFr[i * 4 + 1], uFr[i * 4 + 2], uFr[i * 4 + 3]), c);
  // the lens's far galaxies, bent into arcs, over those and under the stars
  c = over(lensLight(pl - uLn[0].xy), c);
  ${STAR_GLSL}
  // the far sights, over the stars and bent by a black hole between like them: a planet, a battle, the capital ship (and its
  // escort); then the black hole's stream, its dark core and ring over them, and its jets; all under the asteroids,
  // satellites and streaks
  c = over(planet(p, pl), c);
  c = over(battle(pl), c);
  c = over(ship(p, pl), c);
  c = over(lensFeed(p), c);
  c = over(lensHole(p), c);
  c = over(lensJets(p), c);
  // the asteroids' sharp rocks, over the stars and under the satellites and streaks; an empty slot is skipped
  for (int i = 0; i < ASTEROID_N; i++) {
    vec4 a = uAs[i], b = uAs[ASTEROID_N + i];
    if (a.w > 0.0 && b.w < 1.0) c = over(rock(p, a, b, uAs[2 * ASTEROID_N].xy), c);
  }
  // the satellites: each a small soft point (a Gaussian SAT_R CSS px across, uSat's z its alpha) and its beacon's
  // flash (w) a little wider in its colour (uSac); the first empty slot ends them, and a pixel far from one skips it
  for (int i = 0; i < SAT_N; i++) {
    vec4 s = uSat[i];
    if (s.z <= 0.0) break;
    vec2 d = (p - s.xy) / uSize.z;
    float d2 = dot(d, d);
    if (d2 > 36.0) continue;
    float m = s.z * exp(-d2 / ${glf(SAT_R * SAT_R)});
    c = over(vec4(vec3(${SAT_RGB.map(glf).join(', ')}) * m, m), c);
    float fl = s.w * exp(-d2 / ${glf(SAT_FLASH_R * SAT_FLASH_R)});
    if (fl > 0.0) c = over(vec4(uSac[i].rgb * fl, fl), c);
  }
  // the streaks (shooting stars, a shower's): each a soft line about a CSS px wide from its tail end to its head,
  // fading in towards the head (squared), plus a small glow on the head; the first empty slot ends them
  for (int i = 0; i < METEOR_N; i++) {
    vec4 mc = uMc[i], mm = uM[i];
    if (mc.a <= 0.0) break;
    vec2 ab = mm.xy - mm.zw;
    float h = clamp(dot(p - mm.zw, ab) / max(dot(ab, ab), 1e-4), 0.0, 1.0), w = ${glf(METEOR_W)} * uSize.z;
    vec2 e = p - mm.zw - ab * h, o = (p - mm.xy) / (2.0 * w);
    float m = mc.a * min(1.0, h * h * exp(-dot(e, e) / (w * w)) + 0.5 * exp(-dot(o, o)));
    c = over(vec4(mc.rgb * m, m), c);
  }
  // the rockets (a deploy going live): each a trail up its bent path (x = foot + lean s + bend s^2, s the height above
  // its foot, uRk: the foot (x, y), the head's and the tail end's heights; uRp: lean, bend, the head's and the trail's
  // alpha), wavering sideways down it (uRw: its clock, the waver), gold near the head turning orange and faint, with a
  // wider faint glow; the head a soft warm point; at burnout (uRw's z, 0-1; -1 none) sparks flying out and drooping.
  // The first empty slot (uRw's w, the seed, 0) ends them; a pixel off to the side of one skips it
  for (int i = 0; i < ROCKET_N; i++) {
    vec4 r0 = uRk[i], r1 = uRp[i], r2 = uRw[i];
    if (r2.w <= 0.0) break;
    float dp = uSize.z, s = r0.y - p.y, sh = r0.z, st = r0.w;
    vec2 hd = vec2(r0.x + r1.x * sh + r1.y * sh * sh, r0.y - sh);
    float pad = (3.0 * r2.y + ${glf(ROCKET_PUFF_R + 12)}) * dp;
    if (p.x < min(r0.x, hd.x) - pad || p.x > max(r0.x, hd.x) + pad || p.y < hd.y - pad) continue;
    if (r1.w > 0.0 && s > st - 8.0 * dp && s < sh + 8.0 * dp) {
      float ss = clamp(s, st, sh), f = (ss - st) / max(sh - st, 1.0), sc = ss / dp;
      float wv = r2.y * pow(1.0 - f, 1.2) * (0.6 * sin(sc * 0.035 + r2.x * 3.1 + r2.w * 37.7) + 0.4 * sin(sc * 0.011 - r2.x * 1.7));
      float xc = r0.x + r1.x * ss + r1.y * ss * ss + wv * dp, sl = r1.x + 2.0 * r1.y * ss;
      vec2 d = vec2((p.x - xc) / sqrt(1.0 + sl * sl), s - ss) / dp;
      float d2 = dot(d, d);
      if (d2 < 120.0) {
        float w = 0.7 + 1.2 * (1.0 - f), a = r1.w * pow(f, 1.3);
        float m = a * min(1.0, exp(-d2 / (w * w)) + 0.22 * exp(-d2 / (9.0 * w * w)));
        vec3 col = mix(mix(vec3(${ROCKET_ORANGE.map(glf).join(', ')}), vec3(${ROCKET_GOLD.map(glf).join(', ')}), smoothstep(0.0, 0.6, f)), vec3(${ROCKET_HEAD.map(glf).join(', ')}), smoothstep(0.9, 1.0, f));
        c = over(vec4(col * m, m), c);
      }
    }
    vec2 o = (p - hd) / (dp * ${glf(ROCKET_HEAD_R)});
    float o2 = dot(o, o);
    if (r1.z > 0.0 && o2 < 80.0) {
      float m = min(1.0, r1.z * (exp(-o2) + 0.4 * exp(-o2 / 9.0)));
      c = over(vec4(vec3(${ROCKET_HEAD.map(glf).join(', ')}) * m, m), c);
    }
    if (r2.z >= 0.0) {
      float pp = r2.z, rad = ${glf(ROCKET_PUFF_R)} * (1.0 - (1.0 - pp) * (1.0 - pp)), pa = 0.7 * pow(1.0 - pp, 1.5);
      for (int k = 0; k < ${ROCKET_PUFF_N}; k++) {
        float fk = float(k), an = (fk + r2.w) * ${glf((2 * Math.PI) / ROCKET_PUFF_N)} + 0.4 * sin(fk * 12.9 + r2.w * 50.0);
        vec2 q = hd + dp * (rad * (0.7 + 0.3 * fract(fk * 0.618 + r2.w)) * vec2(cos(an), sin(an)) + vec2(0.0, 5.0 * pp * pp));
        vec2 e = (p - q) / (dp * 0.7);
        float m = pa * exp(-dot(e, e));
        c = over(vec4(vec3(${ROCKET_GOLD.map(glf).join(', ')}) * m, m), c);
      }
    }
  }
  // the moon: its picture's texel under the pixel (its texels sit on the pixels), at its alpha
  if (uMo.w > 0.0) {
    vec2 mq = (p - uMo.xy) * uMo.z;
    if (all(greaterThanEqual(mq, vec2(0.0))) && all(lessThan(mq, vec2(1.0)))) c = over(texture(uMoon, mq) * uMo.w, c);
  }
  // the close asteroid (soft focus, its blur 1 px or more), in front of all that, the moon too
  for (int i = 0; i < ASTEROID_N; i++) {
    vec4 a = uAs[i], b = uAs[ASTEROID_N + i];
    if (a.w > 0.0 && b.w >= 1.0) c = over(rock(p, a, b, uAs[2 * ASTEROID_N].xy), c);
  }
  vec2 q = p / uSize.xy * 2.0 - 1.0;
  c = over(vec4(0.0, 0.0, 0.0, uFx.x * smoothstep(0.3, 2.0, dot(q, q))), c);
  // the glows: per repo whose box holds the pixel, its field's texel; the noise is the same for every repo. The field
  // and the noise are laid over the map's box (uOrg: its top left and bottom right, device px), and none shows outside it
  vec2 pm = p - uOrg.xy, f = pm * uGlow.x;
  float cut = -1.0;
  int gn = all(greaterThanEqual(p, uOrg.xy)) && all(lessThan(p, uOrg.zw)) ? uGN : 0;
  for (int i = 0; i < gn; i++) {
    vec4 b = uGB[i];
    if (any(lessThan(f, b.xy)) || any(greaterThan(f, b.zw))) continue;
    vec4 e = uGE[i], m = uGC[i];
    vec4 v = texture(uField, (clamp(f, b.xy + 0.5, b.zw - 0.5) + vec2(e.w, m.w)) * uGlow.zw);
    if (cut < 0.0) cut = (1.0 - ${NEB_GRAIN.toFixed(4)} * textureLod(uNoise, (pm - uN0.xy) * uN0.z, uN0.w).a) *
      (1.0 - ${(NEB_GRAIN * 0.6).toFixed(4)} * textureLod(uNoise, (pm - uN1.xy) * uN1.z, uN1.w).a);
    // the cloud: its lobes (clamped), the noise cut out, the hearts put back; its colour: the edge's, turned to the
    // middle's by what the middles leave, then to the lit colour by what the lit spots leave
    float a = uGlow.y * min(1.0, min(1.0, v.r) * cut + v.g);
    vec3 col = mix(uGL[i].rgb, mix(m.rgb, e.rgb, exp(-v.b)), exp(-v.a));
    c += a * vec4(col, 1.0) * (1.0 - c);
  }
  // a triangular dither of about uFx.w levels: on the colour where the sky is opaque, else on its alpha (the colour
  // kept), so a see-through pixel never gets more colour than alpha
  uvec2 u = uvec2(gl_FragCoord.xy);
  float n = (hash(u) + hash(u + uvec2(7919u, 104729u)) - 1.0) * uFx.w / 255.0;
  if (c.a > 0.998) c.rgb += n; else c *= 1.0 + n / max(c.a, 1.0 / 255.0);
  color = clamp(c, 0.0, 1.0);
}`;
// a software WebGL (SwiftShader, WARP / Microsoft Basic Render, llvmpipe): the sky's shader would take whole seconds a
// frame there, so the canvas draws it. failIfMajorPerformanceCaveat (SKY_GL_ATTRS) refuses most of them already; this
// catches one a browser hands out anyway. The renderer's name comes from WEBGL_debug_renderer_info, else RENDERER
function glSoftware(gl) {
  let name = '';
  try {
    const e = gl.getExtension('WEBGL_debug_renderer_info');
    name = String(gl.getParameter(e ? e.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
  } catch { name = ''; }
  return /swiftshader|software|llvmpipe|softpipe|basic render|mesa offscreen/i.test(name);
}
// the sky's GL state on a canvas, or null without WebGL2 (or with a software one)
function skyGLMake(cv) {
  let gl = null;
  try { gl = cv.getContext('webgl2', SKY_GL_ATTRS); } catch { gl = null; }
  if (!gl) return null;
  if (glSoftware(gl)) {
    try { const lose = gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); } catch { /* let it go */ }
    return null;
  }
  const n = SKY_END;
  const G = { gl, ok: false, pend: null, par: null, loc: [], u: new Float32Array(n), last: new Float32Array(n), drawn: false, dpr: 0, tw: 0, hour: '', tint: null, bgCss: null, bg: null,
    // the glows: their state (see "The repo glows" above and glowPrep)
    glow: false, gp: null, gloc: null, vao: null, buf: null, fb: null, ft: null, fw: 0, fh: 0, fieldOk: false, bufN: 0,
    inst: new Float32Array(64 * GLOW_INST), ni: 0, lastInst: new Float32Array(64 * GLOW_INST), lastNi: -1,
    gu: new Float32Array((3 + 4 * GLOW_MAX) * 4), lastGu: new Float32Array((3 + 4 * GLOW_MAX) * 4), gn: 0, lastGn: -1, cols: new Map() };
  // a lost context: the map's canvas draws the sky from the next frame on, until the context is back
  cv.addEventListener('webglcontextlost', (e) => { e.preventDefault(); G.ok = false; G.pend = null; I.dirty = true; });
  cv.addEventListener('webglcontextrestored', () => { skyGLInit(G); I.dirty = true; });
  skyGLInit(G);
  return G;
}
// two shaders' sources compiled and linked into a program, without waiting for the link (glLinked does)
function glLink(gl, vs, fs) {
  const p = gl.createProgram();
  const sh = [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]].map(([type, src]) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s); gl.attachShader(p, s);
    return s;
  });
  gl.linkProgram(p);
  return { p, sh };
}
// the program glLink started, once linked (this waits for it), or null (said once on the console, unless the
// context is lost)
function glLinked(gl, { p, sh }, what) {
  const ok = !!gl.getProgramParameter(p, gl.LINK_STATUS);
  if (!ok && !gl.isContextLost()) console.warn(`map: the ${what} shader failed, the canvas draws the ${what}:`, sh.map((s) => gl.getShaderInfoLog(s)).join(' ') || gl.getProgramInfoLog(p));
  for (const s of sh) gl.deleteShader(s);
  return ok ? p : null;
}
// a linked program from two shaders' sources, or null
const glProgram = (gl, vs, fs, what) => glLinked(gl, glLink(gl, vs, fs), what);
// The sky's shader is big: a driver without it in its shader cache can take minutes to compile it (D3D11 in a fresh
// browser profile: 198 s, #461), and asking for the link's status waits for all of it with the page frozen. So where
// the browser can link in the background (KHR_parallel_shader_compile) the sky's program is only started here:
// skyGLPoll finishes it once the link is done, and until then the backdrop keeps what it has for SKY_GL_WAIT, then the
// canvas draws the sky. Without the extension it waits for the link here, as it always did.
const SKY_GL_WAIT = 400;
function skyGLInit(G) {
  const gl = G.gl;
  G.ok = false;
  try { G.par = gl.getExtension('KHR_parallel_shader_compile'); } catch { G.par = null; }
  G.pend = glLink(gl, SKY_VS, SKY_FS);
  G.pendAt = performance.now();
  if (!G.par) skyGLFinish(G);
}
// whether the sky's program is ready (G.ok), finishing it when its link is done; never waits for the link
function skyGLPoll(G) {
  if (G.ok) return true;
  if (!G.pend || G.gl.isContextLost()) return false;
  let done = true;
  try { done = !!G.gl.getProgramParameter(G.pend.p, G.par.COMPLETION_STATUS_KHR); } catch { done = true; }
  if (done) { skyGLFinish(G); if (I) I.dirty = true; }
  return G.ok;
}
// the sky's link still runs and began less than SKY_GL_WAIT ago: the backdrop keeps what it has (skyPaint), so a
// driver with the shader in its cache never shows the canvas's sky for a frame first
const skyGLWaits = (G) => !!(G && !G.ok && G.pend && performance.now() - G.pendAt < SKY_GL_WAIT);
// the programs and the textures (the star tiles' pixels come in drawSkyGL, once per dpr); the sky's program and the
// textures stay bound, the glows' program only while it fills the field (glowField)
function skyGLFinish(G) {
  const gl = G.gl, pend = G.pend, p = pend ? glLinked(gl, pend, 'sky') : null;
  G.pend = null;
  G.ok = !!p;
  if (!G.ok) return;
  gl.useProgram(p);
  G.prog = p;
  G.loc = SKY_U.map((name) => gl.getUniformLocation(p, name));
  G.mloc = ['uM', 'uMc'].map((name) => gl.getUniformLocation(p, name));
  G.sloc = ['uSat', 'uSac'].map((name) => gl.getUniformLocation(p, name));
  G.rloc = ['uRk', 'uRp', 'uRw'].map((name) => gl.getUniformLocation(p, name));
  G.nbloc = gl.getUniformLocation(p, 'uNb');
  G.asloc = gl.getUniformLocation(p, 'uAs');
  G.lnloc = gl.getUniformLocation(p, 'uLn');
  G.shloc = gl.getUniformLocation(p, 'uSh');
  G.wploc = gl.getUniformLocation(p, 'uWp');
  G.frloc = gl.getUniformLocation(p, 'uFr'); G.frnloc = gl.getUniformLocation(p, 'uFrN');
  G.plloc = gl.getUniformLocation(p, 'uPl'); G.btloc = gl.getUniformLocation(p, 'uBt');
  G.gloc = ['uGlow', 'uN0', 'uN1', 'uGB', 'uGE', 'uGC', 'uGL', 'uGN'].map((name) => gl.getUniformLocation(p, name));
  SKY_TEX.forEach((name, i) => {
    gl.activeTexture(gl.TEXTURE0 + i);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    // repeated and smoothed like the canvas's pattern, no mipmaps
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.uniform1i(gl.getUniformLocation(p, name), i);
  });
  // the star tints for the layers the shader makes: rgb and the weights summed up to each, over their total
  const tint = new Float32Array(STAR_TINT.length * 4);
  let tsum = 0;
  STAR_TINT.forEach(([rgb, w], i) => { tsum += w; tint.set(rgb.split(',').map((v) => v / 255).concat(tsum / STAR_TINT_SUM), i * 4); });
  gl.uniform4fv(gl.getUniformLocation(p, 'uTint'), tint);
  // a tile's pixels go in premultiplied, as its canvas keeps them
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  G.dpr = 0; G.drawn = false; G.moonKey = '';
  // the moon's picture is sampled only inside it, never repeated
  gl.activeTexture(gl.TEXTURE0 + TEX_MOON);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  // the deep sky's textures (they don't depend on dpr), as they are: its alpha is star-dust density, not coverage
  const D = deepSky();
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.activeTexture(gl.TEXTURE0 + TEX_DEEP);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, DEEP_W, DEEP_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, D.deep);
  gl.activeTexture(gl.TEXTURE0 + TEX_DUST);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, DUST_T, DUST_T, 0, gl.RED, gl.UNSIGNED_BYTE, D.dust);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  // the glows: the noise tile with mipmaps (sampled at the field's scale, as the canvas samples it), the field
  // (its size set in glowPrep, cut to its texels at its edges), and the quads' program
  G.glow = false; G.fieldOk = false; G.fw = G.fh = 0; G.bufN = 0; G.lastNi = -1; G.lastGn = -1;
  try {
    gl.activeTexture(gl.TEXTURE0 + TEX_NOISE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, noiseTile());
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  } catch { return; }
  gl.activeTexture(gl.TEXTURE0 + TEX_FIELD);
  G.ft = gl.getParameter(gl.TEXTURE_BINDING_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 1, 1, 0, gl.RGBA, gl.HALF_FLOAT, null);
  if (!gl.getExtension('EXT_color_buffer_float')) return;
  G.fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, G.fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, G.ft, 0);
  const fbOk = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  G.gp = fbOk ? glProgram(gl, GLOW_VS, GLOW_FS, 'glow') : null;
  if (!G.gp) return;
  G.uA = gl.getUniformLocation(G.gp, 'uA');
  G.vao = gl.createVertexArray(); G.buf = gl.createBuffer();
  gl.bindVertexArray(G.vao); gl.bindBuffer(gl.ARRAY_BUFFER, G.buf);
  ['aC', 'aW', 'aR'].forEach((name, i) => {
    const at = gl.getAttribLocation(G.gp, name);
    gl.enableVertexAttribArray(at);
    gl.vertexAttribPointer(at, 4, gl.FLOAT, false, GLOW_INST * 4, i * 16);
    gl.vertexAttribDivisor(at, 1);
  });
  gl.bindVertexArray(null);
  G.glow = true;
}
// a CSS colour as premultiplied [r, g, b, a] (0-1): painted on one pixel and read back, so any colour the page sets works
function rgbaOf(css) {
  const c = document.createElement('canvas');
  c.width = c.height = 1;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = css; g.fillRect(0, 0, 1, 1);
  const d = g.getImageData(0, 0, 1, 1).data, a = d[3] / 255;
  return [(d[0] / 255) * a, (d[1] / 255) * a, (d[2] / 255) * a, a];
}
// a repo colour's edge, middle and lit colours for the glow shader, rgb 0-1 (as fieldEdge, fieldCore, fieldLit)
function glowCols(G, hex) {
  let v = G.cols.get(hex);
  if (!v) {
    const f = (h) => hexRgb(h).map((c) => c / 255);
    G.cols.set(hex, (v = [f(mixHex(hueTurn(hex, NEB_EDGE_HUE), '#05070d', NEB_EDGE_DARK)), f(hex), f(mixHex(hex, '#ffffff', NEB_LIGHT))]));
  }
  return v;
}
// this frame's glows for the sky's shader: each repo's box placed in the field texture (rows, tallest first), its
// quads (G.inst, G.ni) and the uniforms (G.gu, G.gn); false when the canvas must draw them (see "The repo glows")
function glowPrep(G, byRepo, k, ox, oy, dpr) {
  G.gn = 0; G.ni = 0;
  if (!G.glow || glow2d) return false;
  if (!byRepo) return true;
  const gl = G.gl, q = NEB_RES, w = Math.max(1, Math.ceil(I.W * q)), h = Math.max(1, Math.ceil(I.H * q));
  const boxes = [];
  for (const list of byRepo.values()) {
    const b = glowBox(list, w, h);
    if (b) { b.list = list; boxes.push(b); }
  }
  if (boxes.length > GLOW_MAX) return false;
  boxes.sort((a, b) => b.y1 - b.y0 - (a.y1 - a.y0));
  // rows of boxes, a texel apart so the smoothing never reads a neighbour
  let rx = 0, ry = 0, row = 0;
  for (const b of boxes) {
    const bw = b.x1 - b.x0;
    if (rx + bw > w) { ry += row + 1; rx = 0; row = 0; }
    b.ax = rx; b.ay = ry; rx += bw + 1; row = Math.max(row, b.y1 - b.y0);
  }
  const need = ry + row;
  if (need > GLOW_ROWS * h || need > gl.getParameter(gl.MAX_TEXTURE_SIZE)) return false;
  if (G.fw !== w || G.fh < need) {
    // a bigger field: room for a quarter more, so a slowly growing one isn't made again every frame
    G.fw = w; G.fh = Math.min(GLOW_ROWS * h, Math.ceil((need * 1.25) / 16) * 16);
    gl.activeTexture(gl.TEXTURE0 + TEX_FIELD);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, G.fw, G.fh, 0, gl.RGBA, gl.HALF_FLOAT, null);
    G.fieldOk = false;
  }
  // the quads: per puff its lobes (to the sum), its heart (to the hearts), its middle and its lit spot
  const ts = I.still ? 0 : I.time / 1000;
  let n = 0;
  const quad = (b, x, y, r, w0, w1, w2, w3) => {
    if (G.inst.length < (n + 1) * GLOW_INST) { const a = new Float32Array(G.inst.length * 2); a.set(G.inst); G.inst = a; }
    const o = n++ * GLOW_INST, A = G.inst;
    A[o] = q * x - b.x0 + b.ax; A[o + 1] = q * y - b.y0 + b.ay; A[o + 2] = q * r; A[o + 3] = 0;
    A[o + 4] = w0; A[o + 5] = w1; A[o + 6] = w2; A[o + 7] = w3;
    A[o + 8] = b.ax; A[o + 9] = b.ay; A[o + 10] = b.ax + b.x1 - b.x0; A[o + 11] = b.ay + b.y1 - b.y0;
  };
  const u = G.gu, M = GLOW_MAX * 4;
  boxes.forEach((b, i) => {
    for (const p of b.list) {
      if (p.a < 0.004) continue;
      for (const L of p.lobes) {
        const x = p.sx + (L.x + NEB_WANDER * Math.cos(ts * L.w1 + L.p1)) * p.R;
        const y = p.sy + (L.y + NEB_WANDER * Math.sin(ts * L.w2 + L.p2)) * p.R;
        quad(b, x, y, p.R * L.s * (1 + NEB_BREATHE * Math.sin(ts * L.w3 + L.p3)), Math.min(1, p.a * L.a), 0, 0, 0);
      }
      quad(b, p.sx, p.sy, p.R * NEB_HEART[0], 0, Math.min(1, p.a * NEB_HEART[1]), 0, 0);
      quad(b, p.sx, p.sy, p.R * 1.05, 0, 0, Math.min(1, p.w), 0);
      const L = p.lobes[p.lit];
      const x = p.sx + (L.x + NEB_WANDER * Math.cos(ts * L.w1 + L.p1)) * p.R;
      const y = p.sy + (L.y + NEB_WANDER * Math.sin(ts * L.w2 + L.p2)) * p.R;
      quad(b, x, y, p.R * 0.62 * (1 + NEB_BREATHE * Math.sin(ts * L.w3 + L.p3)), 0, 0, 0, NEB_LIT_A * Math.min(1, p.w));
    }
    const [e, c, l] = glowCols(G, b.list[0].color), o = 12 + i * 4;
    u[o] = b.x0; u[o + 1] = b.y0; u[o + 2] = b.x1; u[o + 3] = b.y1;
    u.set(e, M + o); u[M + o + 3] = b.ax - b.x0;
    u.set(c, 2 * M + o); u[2 * M + o + 3] = b.ay - b.y0;
    u.set(l, 3 * M + o); u[3 * M + o + 3] = 0;
  });
  G.ni = n; G.gn = boxes.length;
  u[0] = q / dpr; u[1] = NEB_A; u[2] = 1 / G.fw; u[3] = 1 / G.fh;
  // the noise layers as the canvas places them (pinned to the map, drifting), in device px, each offset wrapped by
  // its tile; mip level: the tile's texels a field texel spans
  for (let i = 0; i < 2; i++) {
    const T = k * NEB_NOISE[i] * dpr, wrap = (v) => v - Math.floor(v / T) * T;
    u[4 + i * 4] = wrap((ox + ts * NEB_NOISE_DRIFT[i] * k + i * 97 * k) * dpr);
    u[5 + i * 4] = wrap((oy + ts * NEB_NOISE_DRIFT[1 - i] * 0.6 * k + i * 53 * k) * dpr);
    u[6 + i * 4] = 1 / T; u[7 + i * 4] = Math.max(0, Math.log2(128 / (q * k * NEB_NOISE[i])));
  }
  return true;
}
// the field: cleared, then every quad added up (only when they changed)
function glowField(G) {
  const gl = G.gl, A = G.inst.subarray(0, G.ni * GLOW_INST);
  gl.bindFramebuffer(gl.FRAMEBUFFER, G.fb);
  gl.viewport(0, 0, G.fw, G.fh);
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  if (G.ni) {
    gl.useProgram(G.gp); gl.bindVertexArray(G.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, G.buf);
    if (G.bufN < A.length) { G.bufN = G.inst.length; gl.bufferData(gl.ARRAY_BUFFER, G.bufN * 4, gl.DYNAMIC_DRAW); }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, A);
    gl.uniform2f(G.uA, G.fw, G.fh);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, G.ni);
    gl.disable(gl.BLEND); gl.bindVertexArray(null); gl.useProgram(G.prog);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  G.lastInst = G.lastInst.length < G.inst.length ? new Float32Array(G.inst.length) : G.lastInst;
  G.lastInst.set(A); G.lastNi = G.ni; G.fieldOk = true;
}
// the sky (and the repo glows, when it can: I.glowGL) on its canvas, drawn only when its uniforms or the glows'
// quads changed; false when the map's canvas must draw the sky itself
function drawSkyGL(glass, glows, k, ox, oy) {
  const G = I.skyGL;
  if (!G || G.gl.isContextLost() || !skyGLPoll(G)) return false;
  const gl = G.gl, dpr = I.dpr || 1, cv = I.skyCanvas, u = G.u;
  if (G.dpr !== dpr) {
    // each tiled star layer's tile at this dpr into its texture; the tile's canvas is let go at once
    STAR_TILES.forEach((L, i) => {
      const c = starTile(L, dpr);
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
      G.tw = c.width;
      c.width = c.height = 0;
    });
    G.dpr = dpr;
  }
  // the page's colour and the tint are worked out again only when they change
  const bgCss = glass ? '' : I.bgFill || COL.bg;
  if (G.bgCss !== bgCss) { G.bgCss = bgCss; G.bg = bgCss ? rgbaOf(bgCss) : [0, 0, 0, 0]; }
  const h = skyHour(), hk = h.toFixed(3);
  if (G.hour !== hk) { G.hour = hk; G.tint = skyAt(h); }
  const top = G.tint[0], bot = G.tint[1], at = starsAt();
  // in SKY_U's order
  u[0] = cv.width; u[1] = cv.height; u[2] = dpr;
  // the twinkle's clock: the map's, which stops at rest and while hidden, so the sky stays the same and isn't drawn
  // again; awake, the stars' drift redraws it each ambient frame anyway, so twinkle never adds a frame
  u[3] = I.still ? -1 : (I.time / 1000) % TWINKLE_WRAP;
  for (let j = 0; j < 4; j++) {
    u[4 + j] = G.bg[j];
    u[8 + j] = j < 3 ? top[j] / 255 : top[3];
    u[12 + j] = j < 3 ? bot[j] / 255 : bot[3];
  }
  for (let i = 0, o = 16; i < STAR_LAYERS.length; i++, o += 4) {
    const s = at[i * 3];
    // a layer the shader makes: star px = device px / (s dpr) + its star space at the top left
    if (STAR_LAYERS[i].cell) { u[o] = starWide[i * 2]; u[o + 1] = starWide[i * 2 + 1]; u[o + 2] = 1 / (s * dpr); u[o + 3] = s * dpr; continue; }
    // drawStars's pattern puts a tile's pixel (tx, ty) on device px (s tx + ex dpr, s ty + ey dpr): the shader goes back
    u[o] = at[i * 3 + 1] * dpr; u[o + 1] = at[i * 3 + 2] * dpr; u[o + 2] = 1 / (s * G.tw);
  }
  // the deep sky and its dust, each offset wrapped by its own repeat (device px)
  const ds = deepPos[0], dw = DEEP_W * DEEP_PX * ds * dpr, dh = DEEP_H * DEEP_PX * ds * dpr, dt = DUST_T * ds;
  const dx = deepPos[1] * dpr, dy = deepPos[2] * dpr, wrap = (v, P) => v - Math.floor(v / P) * P;
  u[28] = wrap(dx, dw); u[29] = wrap(dy, dh); u[30] = 1 / dw; u[31] = 1 / dh;
  u[32] = wrap(dx, dt); u[33] = wrap(dy, dt); u[34] = 1 / dt; u[35] = 0;
  u[36] = VIG_A[glass ? 1 : 0]; u[37] = DEEP_A; u[38] = DUST_A; u[39] = DITHER;
  // the moon (its picture into its texture when its phase or the dpr changed; all 0 when it isn't shown)
  const mo = moonAt(dpr);
  if (mo && G.moonKey !== mo.im.key) {
    gl.activeTexture(gl.TEXTURE0 + TEX_MOON);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mo.im.c);
    G.moonKey = mo.im.key; G.drawn = false;
  }
  u[40] = mo ? mo.x : 0; u[41] = mo ? mo.y : 0; u[42] = mo ? 1 / mo.im.S : 0; u[43] = mo ? mo.a : 0;
  // the map's box in the window, device px (the glows are laid over it; all 0 with the Map hidden: no glows)
  const bx = mapX() * dpr, by = mapY() * dpr;
  u[44] = I.mapOn ? bx : 0; u[45] = I.mapOn ? by : 0; u[46] = I.mapOn ? bx + I.W * dpr : 0; u[47] = I.mapOn ? by + I.H * dpr : 0;
  // the streaks (all 0 when none: the frame after the last ends draws the sky without it)
  const ms = meteorsNow(), M = SKY_M, MC = SKY_M + METEOR_N * 4;
  u.fill(0, M);
  ms.forEach((m, i) => {
    u[M + i * 4] = m.hx * dpr; u[M + i * 4 + 1] = m.hy * dpr; u[M + i * 4 + 2] = m.tx * dpr; u[M + i * 4 + 3] = m.ty * dpr;
    for (let j = 0; j < 3; j++) u[MC + i * 4 + j] = m.rgb[j] / 255;
    u[MC + i * 4 + 3] = m.a;
  });
  // the satellites, after the streaks (all 0 when none)
  const S = SKY_M + METEOR_N * 8, SC = S + SAT_N * 4;
  satsNow().forEach((s, i) => {
    u[S + i * 4] = s.x * dpr; u[S + i * 4 + 1] = s.y * dpr; u[S + i * 4 + 2] = s.a; u[S + i * 4 + 3] = (SAT_FLASH_A * s.f * s.a) / SAT_A;
    for (let j = 0; j < 3; j++) u[SC + i * 4 + j] = s.rgb[j];
  });
  // the rockets, after the satellites (all 0 when none: the frame after the last is gone draws the sky without it)
  const R = SKY_M + METEOR_N * 8 + SAT_N * 8, RN = ROCKET_N * 4;
  rocketsNow().forEach((r, i) => {
    const o = R + i * 4;
    u[o] = r.x0 * dpr; u[o + 1] = r.yb * dpr; u[o + 2] = r.sh * dpr; u[o + 3] = r.st * dpr;
    u[o + RN] = r.lean; u[o + RN + 1] = r.bend / dpr; u[o + RN + 2] = r.ha; u[o + RN + 3] = r.ta;
    u[o + 2 * RN] = r.ph; u[o + 2 * RN + 1] = r.wave; u[o + 2 * RN + 2] = r.puff; u[o + 2 * RN + 3] = r.seed;
  });
  // the nebula drift, after the rockets (all 0 when none)
  const nb = nebulaNow();
  if (nb) {
    const o = SKY_NB;
    u[o] = nb.x * dpr; u[o + 1] = nb.y * dpr; u[o + 2] = nb.r * dpr; u[o + 3] = nb.a;
    u[o + 4] = Math.cos(nb.rot); u[o + 5] = Math.sin(nb.rot); u[o + 6] = nb.aspect; u[o + 7] = nb.seed;
    for (let q = 0; q < 3; q++) for (let j = 0; j < 3; j++) u[o + 8 + q * 4 + j] = nb.rgb[q][j];
    u[o + 19] = nb.age;
  }
  // the asteroid field, after the nebula (all 0 when none): far to near, the light's direction last
  const rk = asteroidsNow();
  if (rk.length) {
    rk.forEach((r, i) => {
      const o = SKY_AS + i * 4, ob = o + ASTEROID_N * 4;
      u[o] = r.x * dpr; u[o + 1] = r.y * dpr; u[o + 2] = r.r * dpr; u[o + 3] = r.a;
      u[ob] = Math.cos(r.rot); u[ob + 1] = Math.sin(r.rot); u[ob + 2] = r.asp; u[ob + 3] = Math.floor(r.blur * dpr) + r.seed;
    });
    const l = evOf('asteroids').ev.light, ol = SKY_AS + ASTEROID_N * 8;
    u[ol] = l[0]; u[ol + 1] = l[1];
  }
  // the gravity lens, after the asteroids (all 0 when none)
  const ln = lensNow();
  if (ln) {
    const o = SKY_LN;
    u[o] = ln.x * dpr; u[o + 1] = ln.y * dpr; u[o + 2] = ln.r * dpr; u[o + 3] = 1;
    ln.srcs.forEach((q, i) => {
      const b = o + 4 + i * 8;
      u[b] = q.bx * dpr; u[b + 1] = q.by * dpr; u[b + 2] = q.sig * dpr; u[b + 3] = q.amp;
      u[b + 4] = Math.cos(q.rot); u[b + 5] = Math.sin(q.rot); u[b + 6] = q.asp;
    });
    u[o + 11] = ln.phi;
    // what it is eating, and the flare and jets after a meal
    if (ln.feed) {
      const f = ln.feed;
      u[o + 20] = f.rho * dpr; u[o + 21] = f.th; u[o + 22] = f.w * DEVOUR_WIND; u[o + 23] = f.width * dpr;
      u[o + 24] = f.rgb[0]; u[o + 25] = f.rgb[1]; u[o + 26] = f.rgb[2]; u[o + 27] = f.a;
    }
    u[o + 28] = ln.flare; u[o + 29] = ln.jet; u[o + 30] = ln.jl * dpr; u[o + 31] = ln.jb * dpr; u[o + 32] = ln.t;
  }
  // the capital ship, after the lens (all 0 when none); falling into the black hole: drawn where it is, not bent by it, and
  // gone into the dark as it reaches the ring
  const sh = shipNow();
  if (sh) {
    const o = SKY_SH, ff = sh.fall ? sh.fall.f : 0;
    u[o] = sh.x * dpr; u[o + 1] = sh.y * dpr; u[o + 2] = sh.r * dpr; u[o + 3] = sh.a * (1 - sm01((ff - 0.86) / 0.14));
    if (!sh.j && sh.sm) u[o + 17] = sh.sm;
    u[o + 20] = sh.heat || 0; u[o + 21] = sh.fall ? sh.fall.ease : 0;
    u[o + 4] = sh.cs; u[o + 5] = sh.sn; u[o + 6] = sh.flip; u[o + 7] = sh.seed;
    if (sh.eo) for (let j = 0; j < 4; j++) u[o + 8 + j] = sh.eo[j];
    if (sh.j) {
      u[o + 12] = sh.j.x * dpr; u[o + 13] = sh.j.y * dpr; u[o + 14] = sh.j.h * dpr; u[o + 15] = sh.j.a;
      u[o + 16] = sh.j.fl; u[o + 17] = sh.j.sm; u[o + 18] = 1; u[o + 19] = sh.j.t;
    }
  }
  // the warp drift, after the ship (all 0 when none)
  const wp = warpNow();
  if (wp) {
    const o = SKY_WP;
    u[o] = wp.x * dpr; u[o + 1] = wp.y * dpr; u[o + 2] = wp.dx; u[o + 3] = wp.dy;
    u[o + 4] = wp.a * WARP_STRETCH; u[o + 5] = WARP_RADIAL; u[o + 6] = WARP_DEEP;
  }
  // the far event's parts, after the warp (all 0 when none), and how many (uFrN)
  const fr = farNow();
  G.frn = fr.length;
  fr.forEach((q, i) => {
    const o = SKY_FR + i * 16;
    u[o] = q.x * dpr; u[o + 1] = q.y * dpr; u[o + 2] = q.r * dpr; u[o + 3] = q.a;
    u[o + 4] = q.form; u[o + 5] = q.u; u[o + 6] = q.seed; u[o + 7] = q.ang;
    u[o + 8] = q.rgb[0]; u[o + 9] = q.rgb[1]; u[o + 10] = q.rgb[2]; u[o + 11] = q.p;
    u[o + 12] = q.t; u[o + 13] = q.en; u[o + 14] = q.ex;
  });
  // the planet, after the far event (all 0 when none): its star turned into its axis's roll, as the shader turns the pixel
  const pl = planetNow();
  if (pl) {
    const o = SKY_PL, K = PLANET_KINDS[pl.kind], c = Math.cos(pl.tilt), s = Math.sin(pl.tilt), L = pl.light, ff = pl.fall ? pl.fall.f : 0;
    u[o] = pl.x * dpr; u[o + 1] = pl.y * dpr; u[o + 2] = pl.r * dpr; u[o + 3] = 1 - sm01((ff - 0.86) / 0.14);
    u[o + 4] = L[0] * c + L[1] * s; u[o + 5] = -L[0] * s + L[1] * c; u[o + 6] = L[2]; u[o + 7] = pl.kind;
    u[o + 8] = c; u[o + 9] = s; u[o + 10] = pl.spin; u[o + 11] = pl.seed;
    for (let j = 0; j < 3; j++) { u[o + 12 + j] = K[2][j]; u[o + 16 + j] = K[0][j]; u[o + 20 + j] = K[1][j]; }
    u[o + 15] = K[3]; u[o + 19] = pl.open; u[o + 23] = pl.spin * PLANET_CLOUD;
    u[o + 24] = pl.tide ? pl.tide[0] : 1; u[o + 25] = pl.tide ? pl.tide[1] : 0; u[o + 26] = pl.st || 1; u[o + 27] = pl.heat || 0;
    if (pl.moon) { u[o + 28] = pl.moon.x; u[o + 29] = pl.moon.y; u[o + 30] = pl.moon.r; u[o + 31] = pl.moon.z >= 0 ? 1 : -1; }
    if (pl.ring) { u[o + 32] = pl.ring.in; u[o + 33] = pl.ring.out; }
    u[o + 34] = pl.fall ? pl.fall.ease : 0;
  }
  // the battle, after the planet (all 0 when none): its middle and reach, how many of each, then the hulls, streaks and blasts
  const bt = battleNow();
  if (bt) {
    const o = SKY_BT;
    u[o] = bt.x * dpr; u[o + 1] = bt.y * dpr; u[o + 2] = bt.reach * dpr;
    u[o + 4] = bt.hulls.length; u[o + 5] = bt.streaks.length; u[o + 6] = bt.blasts.length; u[o + 7] = bt.s;
    bt.hulls.forEach((h, i) => {
      const b = o + 8 + i * 20, j = h.j;
      u[b] = h.x * dpr; u[b + 1] = h.y * dpr; u[b + 2] = h.r * dpr; u[b + 3] = h.a;
      u[b + 4] = h.cs; u[b + 5] = h.sn; u[b + 6] = h.flip; u[b + 7] = h.seed;
      if (j) {
        u[b + 8] = j.x * dpr; u[b + 9] = j.y * dpr; u[b + 10] = j.h * dpr; u[b + 11] = j.a;
        u[b + 12] = j.fl; u[b + 14] = j.cut; u[b + 15] = j.t;
      }
      u[b + 13] = h.sm;
      u[b + 16] = h.side; u[b + 17] = h.half; u[b + 18] = h.cut; u[b + 19] = h.heat;
    });
    bt.streaks.forEach((q, i) => {
      const b = o + 8 + BATTLE_HULLS * 20 + i * 8;
      u[b] = q.hx * dpr; u[b + 1] = q.hy * dpr; u[b + 2] = q.tx * dpr; u[b + 3] = q.ty * dpr;
      u[b + 4] = q.rgb[0]; u[b + 5] = q.rgb[1]; u[b + 6] = q.rgb[2]; u[b + 7] = Math.min(1, q.a) + q.type * 2;
    });
    bt.blasts.forEach((q, i) => {
      const b = o + 8 + BATTLE_HULLS * 20 + BATTLE_STREAKS * 8 + i * 8;
      u[b] = q.x * dpr; u[b + 1] = q.y * dpr; u[b + 2] = q.r * dpr; u[b + 3] = q.a;
      u[b + 4] = q.age; u[b + 5] = q.seed || 0; u[b + 6] = q.kind; u[b + 7] = q.side || 0;
    });
  }
  I.glowGL = glowPrep(G, glows, k, ox, oy, dpr);
  // the field again when its quads changed; the sky's pass when anything it shows did
  let fresh = !G.gn || (G.fieldOk && G.ni === G.lastNi);
  for (let j = 0, n = G.gn ? G.ni * GLOW_INST : 0; fresh && j < n; j++) fresh = G.inst[j] === G.lastInst[j];
  let same = fresh && G.drawn && G.gn === G.lastGn;
  for (let j = 0; same && j < u.length; j++) same = u[j] === G.last[j];
  for (let j = 0, n = 12 + G.gn * 4; same && j < n; j++) same = G.gu[j] === G.lastGu[j];
  for (let j = 1; same && j < 4; j++) for (let i = 0; same && i < G.gn * 4; i++) same = G.gu[12 + j * GLOW_MAX * 4 + i] === G.lastGu[12 + j * GLOW_MAX * 4 + i];
  if (same) return true;
  if (G.gn && !fresh) glowField(G);
  G.last.set(u); G.lastGu.set(G.gu); G.lastGn = G.gn; G.drawn = true; G.draws = (G.draws || 0) + 1;
  gl.viewport(0, 0, cv.width, cv.height);
  for (let j = 0; j < SKY_U.length; j++) gl.uniform4fv(G.loc[j], u, j * 4, 4);
  for (let j = 0; j < 2; j++) gl.uniform4fv(G.mloc[j], u, SKY_M + j * METEOR_N * 4, METEOR_N * 4);
  for (let j = 0; j < 2; j++) gl.uniform4fv(G.sloc[j], u, SKY_M + METEOR_N * 8 + j * SAT_N * 4, SAT_N * 4);
  for (let j = 0; j < 3; j++) gl.uniform4fv(G.rloc[j], u, SKY_M + METEOR_N * 8 + SAT_N * 8 + j * ROCKET_N * 4, ROCKET_N * 4);
  gl.uniform4fv(G.nbloc, u, SKY_NB, 20);
  gl.uniform4fv(G.asloc, u, SKY_AS, ASTEROID_N * 8 + 4);
  gl.uniform4fv(G.lnloc, u, SKY_LN, 36);
  gl.uniform4fv(G.shloc, u, SKY_SH, 24);
  gl.uniform4fv(G.wploc, u, SKY_WP, 8);
  gl.uniform4fv(G.frloc, u, SKY_FR, FAR_N * 16); gl.uniform1i(G.frnloc, G.frn);
  gl.uniform4fv(G.plloc, u, SKY_PL, 36);
  gl.uniform4fv(G.btloc, u, SKY_BT, SKY_BT_N * 4);
  if (G.glow) {
    const L = G.gloc, gu = G.gu, M = GLOW_MAX * 4;
    for (let j = 0; j < 3; j++) gl.uniform4fv(L[j], gu, j * 4, 4);
    for (let j = 0; j < 4; j++) gl.uniform4fv(L[3 + j], gu, 12 + j * M, M);
    gl.uniform1i(L[7], G.gn);
  }
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  G.painted = true; // a new picture for the backdrop (skyPaint)
  return true;
}

// the sky on the page's backdrop (I.skyEl): the sky's shader's picture, copied only when it drew a new one (it carries
// the page's colour when not in glass), or, without it, the canvas's own sky drawn there each time. glows: the repo
// glows of the Map (null with the Map hidden), in the map's CSS px, for the shader (I.glowGL says it took them)
function skyPaint(glass, glows, k, ox, oy) {
  I.glowGL = false;
  const g = I.skyCtx;
  if (!g) return;
  const w = I.skyEl.width, h = I.skyEl.height;
  if (drawSkyGL(glass, glows, k, ox, oy)) {
    if (!I.skyGL.painted) return;
    I.skyGL.painted = false;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
    g.drawImage(I.skyCanvas, 0, 0);
    return;
  }
  if (skyGLWaits(I.skyGL)) return; // the sky's shader is about to be ready (skyGLInit)
  g.setTransform(1, 0, 0, 1, 0, 0);
  if (glass) g.clearRect(0, 0, w, h);
  else { g.fillStyle = I.bgFill || COL.bg; g.fillRect(0, 0, w, h); }
  screen(g);
  drawSky(g);
  drawStars(g);
  drawSats(g);
  drawMeteors(g);
  drawRockets(g);
  drawMoon(g);
}
// a frame with the Map hidden: the sky alone, behind the view that shows
function drawSkyOnly() {
  if (!I.skyW || !I.skyH) return;
  skyPaint(document.documentElement.classList.contains('glass'), null, 1, 0, 0);
}

function draw() {
  const ctx = I.ctx, W = I.W, H = I.H;
  if (!W || !H || !I.cam) return;
  screen(ctx);
  // glass (the desktop window): the canvas stays see-through so the window's acrylic shows behind the map
  const glass = document.documentElement.classList.contains('glass');
  const k = K(), ks = ksOf(k);
  bendCap = BEND_MAX * ks;
  const ox = I.W / 2 - (I.cam.cx + I.pan.x) * k, oy = I.H / 2 - (I.cam.cy + I.pan.y) * k;
  // the repo glows sit right over the sky, under everything else: the sky's shader draws them when it can
  const glows = territoryPuffs(k, ks, ox, oy);
  skyPaint(glass, glows, k, ox, oy);
  // the sky is the backdrop behind this canvas, which only carries the map
  ctx.clearRect(0, 0, W, H);
  if (!I.glowGL) drawTerritories(ctx, k, ox, oy, glows);
  const nowC = Date.now() - I.skew;
  const selNode = I.sel ? I.byId.get(I.sel) : null;
  const hovNode = I.hover ? I.byId.get(I.hover) : null;
  const focusSid = (hovNode && hovNode.sid) || (selNode && selNode.sid) || null;

  // screen positions, plus a slow drift that is purely a draw offset (the layout never sees it)
  const amp = I.still ? 0 : DRIFT_PX * ks, tm = I.time;
  for (const n of I.sim) {
    let x = n.p.x * k + ox, y = n.p.y * k + oy;
    const d = n.dr;
    if (amp && d) {
      x += amp * (0.7 * Math.sin(tm * d[0] + d[1]) + 0.3 * Math.sin(tm * d[2] + d[3]));
      y += amp * (0.7 * Math.sin(tm * d[4] + d[5]) + 0.3 * Math.sin(tm * d[6] + d[7]));
    }
    n.sx = x; n.sy = y;
  }
  const nowP = performance.now();
  I.nowP = nowP;
  for (const n of I.nodes) {
    if (n.kind === 'session') { const L = lookOf(n, nowP); n.R = L.rb * ks; n.RG = n.R + (n.fin ? 2.5 : 4.5) * ks; n.bs = bumpScale(n.id, nowP) * L.grow; }
    else if (n.kind === 'repo') {
      const H = hubOf(n, nowP);
      n.R = HUB_R * ks * (0.84 + 0.16 * H.pres + 0.04 * Math.min(H.act, 3)) * H.grow;
      n.RG = n.R * (HUB_TICKS + (SAT_RING + 0.2 - HUB_TICKS) * H.pres) + 1.5 * ks; n.bs = bumpScale(n.id, nowP);
      // worktree satellites ride an outer ring: its name goes outside them (RO), its hit area stays the hub (RG)
      n.RO = n.wtsLive && n.wtsLive.length ? Math.max(n.RG, n.R * WT_RING + 3.6 * ks) : n.RG;
    }
    else if (n.kind === 'pr') n.R = 6.5 * ks;
    else if (n.kind === 'clash') n.R = 4.6 * ks;
    else if (n.kind === 'conflict') { n.R = 6.8 * ks; n.RG = undefined; }
    else if (n.kind === 'recent') n.R = 2.6 * ks;
  }
  // agents: on slots around their conversation, eased by angle so a new agent slides in
  // running agents also orbit slowly (their offset only advances while they run, so done ones stay put)
  let orbitMoving = false;
  const orbStep = I.still ? 0 : (TAU * (I.adt ?? 16)) / ORBIT_TURN_MS;
  for (const n of I.nodes) {
    if (n.kind !== 'agent') continue;
    const sn = I.byId.get(n.parent);
    let off = I.orb.get(n.id) || 0;
    if (orbStep && n.a.state === 'run') { off = (off + orbStep) % TAU; I.orb.set(n.id, off); }
    // the slot eases (a short slide); the orbit is added after, so a steady orbit is ambient motion, not a slide
    const target = -Math.PI / 2 + (n.idx / n.count) * Math.PI * 2 + (n.count > 1 ? 0 : Math.PI / 4);
    let a0 = I.ang.get(n.id);
    if (a0 === undefined) a0 = target;
    let d = target - a0; d = Math.atan2(Math.sin(d), Math.cos(d));
    if (Math.abs(d) > 0.002) { a0 += d * 0.15; orbitMoving = true; } else a0 = target;
    I.ang.set(n.id, a0);
    const a = a0 + off;
    const ro = Math.max(32 * k, sn.RG + 10 * ks) + (n.count > 10 ? 4 * ks : 0);
    n.sx = sn.sx + Math.cos(a) * ro; n.sy = sn.sy + Math.sin(a) * ro; n.R = 3.6 * ks; n.ang = a;
    const lv0 = I.agl.get(n.id);
    n.lv = glide(lv0 === undefined ? (n.a.state === 'run' ? 1 : 0) : lv0, n.a.state === 'run' ? 1 : 0, 600);
    I.agl.set(n.id, n.lv);
  }
  if (orbitMoving) I.quick = true;
  I.k = k;

  const byId = I.byId;
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  // hit areas of the things that aren't nodes, rebuilt every frame
  I.linkHits = []; I.wtHits = []; I.parGhosts = []; I.virt.clear();

  // auras: a soft glow in the conversation's colour whose SIZE follows its last 20 minutes of tool calls
  // (eased over ~2 s); its alpha is fixed, so nothing gets brighter when something happens
  // A finished conversation's aura shrinks away instead of vanishing.
  const auraK = I.still ? 1 : 1 - Math.exp(-(I.dt || 16) / 600);
  for (const n of I.nodes) {
    if (n.kind !== 'session' || n.s.pending) continue;
    const want = n.s.state === 'DONE' ? 0 : AURA_MIN + ((AURA_MAX - AURA_MIN) * Math.min(n.s.calls20 || 0, AURA_CALLS)) / AURA_CALLS;
    let r0 = I.aura.get(n.id);
    r0 = r0 === undefined ? want : r0 + (want - r0) * auraK;
    if (Math.abs(want - r0) > 0.05) I.quick = true;
    I.aura.set(n.id, r0);
    if (r0 < 0.6) { n.aura = 0; continue; }
    const R = Math.max(r0 * ks, (n.RG + 3 * ks) * Math.min(1, r0 / AURA_MIN));
    n.aura = R;
    if (n.sx + R < 0 || n.sx - R > W || n.sy + R < 0 || n.sy - R > H) continue;
    const hue = I.lens === 'state' || n.s.state === 'DONE' ? n.s.hue || COL.cyan : lensColor(I.lens, n.s);
    unit(ctx, n.sx, n.sy, R);
    ctx.fillStyle = cache('aura', hue, '', buildAura);
    ctx.beginPath(); ctx.arc(0, 0, 1, 0, TAU); ctx.fill();
    screen(ctx);
    // working: a ring of small dots that slowly turns (constant alpha); going idle it slows to a stop while the
    // dots shrink and draw in toward the orb, and starting work they grow back out as it picks up speed
    const L = I.look.get(n.id), b = L ? L.busy : 0;
    if (b > 0.02) {
      const rr = Math.max(R * 0.8, n.RG + 4 * ks) * (0.8 + 0.2 * b), dr = 1.2 * ks * b;
      ctx.fillStyle = rgba(hue, 0.5);
      ctx.beginPath();
      for (let i = 0; i < RING_DOTS; i++) {
        const a = L.ringA + (i / RING_DOTS) * TAU;
        const x = n.sx + Math.cos(a) * rr, y = n.sy + Math.sin(a) * rr;
        ctx.moveTo(x + dr, y); ctx.arc(x, y, dr, 0, TAU);
      }
      ctx.fill();
    }
  }

  // links: conversation -> repo (a gradient from its colour to the repo's), -> PR, -> shared file, -> agents
  for (const e of I.springs) {
    const a = byId.get(e.a), b = byId.get(e.b);
    if (!a || !b) continue;
    if (b.kind === 'repo') {
      const L = I.look.get(a.id), lv = L ? L.live : a.s.state === 'DONE' ? 0 : 1;
      if (lv > 0.01 && lv < 0.99) { ctx.globalAlpha = (EDGE_DONE_A + (EDGE_LIVE_A - EDGE_DONE_A) * lv) / EDGE_LIVE_A; gradCurve(ctx, a, b, a.s.hue, b.color, 1.1, false); ctx.globalAlpha = 1; }
      else gradCurve(ctx, a, b, a.s.hue, b.color, 1.1, lv <= 0.01);
    }
    else if (b.kind === 'pr') {
      ctx.strokeStyle = rgba(shipColor(b.ship), 0.32); ctx.lineWidth = 0.9;
      curve(ctx, a, b);
    }
    else if (b.kind === 'clash') {
      // steady, in the clash's colour: its recent-work paths (below) only run while the file was touched in the
      // last ten minutes, and a finished conversation has none
      ctx.strokeStyle = rgba(b.c.writers >= 2 ? COL.red : COL.gold, CLASH_LINK_ALPHA); ctx.lineWidth = 1;
      curve(ctx, a, b);
    }
  }
  for (const n of I.nodes) {
    if (n.kind !== 'agent') continue;
    const sn = byId.get(n.parent);
    ctx.strokeStyle = rgba(n.a.state === 'fail' ? COL.red : n.s.hue, 0.14 + 0.18 * n.lv); ctx.lineWidth = 0.9;
    const ux = Math.cos(n.ang), uy = Math.sin(n.ang);
    line(ctx, sn.sx + ux * (sn.RG + 2), sn.sy + uy * (sn.RG + 2), n.sx - ux * n.R, n.sy - uy * n.R);
  }

  // recent-work paths: steady fade from 0.9 to 0.08 over ten minutes, from timestamps every frame, never below
  // PATH_MIN_ALPHA; while the conversation works, the dashes flow from it toward the file (opacity unchanged)
  const fileAlpha = I.fileAlpha || (I.fileAlpha = new Map());
  fileAlpha.clear();
  const flow = I.still ? 0 : (I.time / 1000) * FLOW_PX_S;
  for (const p of I.paths) {
    const a = byId.get(p.a), b = byId.get(p.b);
    if (!a || !b) continue;
    const age = clamp((nowC - p.t) / FADE_MS, 0, 1);
    const op = 0.9 - 0.82 * age;
    const dim = focusSid && a.sid !== focusSid ? 0.45 : 1;
    ctx.strokeStyle = rgba(p.hue, Math.max(PATH_MIN_ALPHA, op * 0.6 * dim)); ctx.lineWidth = p.wrote ? 1.1 : 0.9;
    if (flow && BUSY.has(a.s.state)) { I.lively = true; ctx.setLineDash(p.wrote ? DASH_WROTE_FLOW : DASH_READ); ctx.lineDashOffset = -flow; }
    else { ctx.setLineDash(p.wrote ? DASH_NONE : DASH_READ); ctx.lineDashOffset = 0; }
    curve(ctx, a, b);
    fileAlpha.set(b.id, Math.max(fileAlpha.get(b.id) || 0, op));
  }
  ctx.setLineDash(DASH_NONE); ctx.lineDashOffset = 0;

  // command center links: handoff trails, parity pairs, teams, conflicts' lines to their conversations
  drawTrails(ctx, ks);
  drawParity(ctx, ks);
  drawTeams(ctx, ks);
  for (const e of I.springs) {
    if (!e.conflict) continue;
    const a = byId.get(e.a), b = byId.get(e.b);
    if (!a || !b || a.sx === undefined || b.sx === undefined) continue;
    ctx.strokeStyle = rgba(conflictColor(b.k), CONFLICT_LINE_ALPHA); ctx.lineWidth = 1.1; ctx.setLineDash(DASH_LINK);
    curve(ctx, a, b);
    ctx.setLineDash(DASH_NONE);
  }

  // clash lines: dashed between every pair of conversations sharing a file; red when 2+ edited it
  const pairCount = I.pairCount || (I.pairCount = new Map());
  pairCount.clear();
  const clashLabels = [];
  for (const c of I.clashes) {
    const color = c.writers >= 2 ? COL.red : COL.gold;
    const lab = { c, color, mids: [] };
    clashLabels.push(lab);
    for (let i = 0; i < c.sessions.length; i++) {
      for (let j = i + 1; j < c.sessions.length; j++) {
        const a = byId.get('s:' + c.sessions[i].id), b = byId.get('s:' + c.sessions[j].id);
        if (!a || !b) continue;
        const key = a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id;
        const nth = pairCount.get(key) || 0;
        pairCount.set(key, nth + 1);
        const off = nth === 0 ? 0 : (nth % 2 ? 1 : -1) * Math.ceil(nth / 2) * 16;
        const dx = b.sx - a.sx, dy = b.sy - a.sy, d = Math.hypot(dx, dy) || 1;
        const px = -dy / d, py = dx / d;
        const base = bend(a, b);
        const cx = base.x + px * off * 2, cy = base.y + py * off * 2;
        ctx.strokeStyle = rgba(color, 0.62); ctx.lineWidth = 1.3; ctx.setLineDash(DASH_CLASH);
        ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.quadraticCurveTo(cx, cy, b.sx, b.sy); ctx.stroke();
        ctx.setLineDash(DASH_NONE);
        lab.mids.push({ ax: a.sx, ay: a.sy, bx: b.sx, by: b.sy, cx, cy });
      }
    }
  }

  drawComets(ctx, ks, false);

  // nodes
  for (const n of I.nodes) {
    if (n.kind === 'recent') {
      const op = Math.max(0.14, fileAlpha.get(n.id) || 0.08);
      if (n.f.wrote) { ctx.fillStyle = rgba(n.s.hue, op); circle(ctx, n.sx, n.sy, n.R); ctx.fill(); }
      else { ctx.strokeStyle = rgba(COL.dim, op); ctx.lineWidth = 1.1; circle(ctx, n.sx, n.sy, n.R * 0.85); ctx.stroke(); }
    }
  }
  for (const n of I.nodes) {
    if (n.kind === 'clash') {
      const color = n.c.writers >= 2 ? COL.red : COL.gold;
      ctx.fillStyle = HOLE; circle(ctx, n.sx, n.sy, n.R + 1.4); ctx.fill();
      orb(ctx, n.sx, n.sy, n.R, color);
    } else if (n.kind === 'repo') {
      drawHub(ctx, n);
      drawDeploy(ctx, n, ks);
      if (I.multiRepos.has(n.id)) {
        // in the multi-selection: the same steady double ring as a conversation's
        const r = n.R * (n.bs || 1) * SAT_RING;
        ctx.strokeStyle = COL.cyan; ctx.lineWidth = 1.2;
        circle(ctx, n.sx, n.sy, r + 4.5 * ks); ctx.stroke();
        circle(ctx, n.sx, n.sy, r + 7.7 * ks); ctx.stroke();
      }
      if (I.drag && I.drag.drop === n.id) {
        // where a dragged conversation will move to
        ctx.save(); ctx.setLineDash([5, 4]); ctx.strokeStyle = rgba(n.color || COL.dim, 0.9); ctx.lineWidth = 2;
        circle(ctx, n.sx, n.sy, n.R * 2.2 + 10); ctx.stroke(); ctx.restore();
      }
    } else if (n.kind === 'pr') {
      drawPr(ctx, n, ks);
    } else if (n.kind === 'conflict') {
      drawConflict(ctx, n, ks);
    } else if (n.kind === 'agent') {
      if (n.a.state === 'fail') {
        ctx.strokeStyle = COL.red; ctx.lineWidth = 1.8; cross(ctx, n.sx, n.sy, n.R * 0.8);
      } else {
        // a finished agent settles: smaller and dimmer over 600 ms
        ctx.globalAlpha = 0.42 + 0.58 * n.lv; orb(ctx, n.sx, n.sy, n.R * (0.85 + 0.15 * n.lv), n.s.hue); ctx.globalAlpha = 1;
      }
    }
  }
  for (const n of I.nodes) if (n.kind === 'session') drawSession(ctx, n, ks, n.id === I.sel, n.id === I.hover);
  drawLeadBadges(ctx, ks);
  drawParityGhosts(ctx, k, ks);
  drawGhosts(ctx, ks);
  // comets into a repo ride over its hub and fade out inside the core; a merge's sparks fly out over it
  drawComets(ctx, ks, true);
  drawBursts(ctx, ks);
  // selection / hover ring for non-conversation nodes
  for (const id of [I.hover, I.sel]) {
    const n = id && byId.get(id);
    if (!n || n.kind === 'session') continue;
    ctx.strokeStyle = id === I.sel ? COL.cyan : rgba(COL.dim, 0.7); ctx.lineWidth = id === I.sel ? 1.6 : 1;
    circle(ctx, n.sx, n.sy, (n.kind === 'repo' ? n.RG : n.R) + 4 * ks); ctx.stroke();
  }

  drawLabels(ctx, k, ks, clashLabels, selNode, hovNode, fileAlpha);
  // the rubber band (Ctrl+drag): a thin dashed rectangle at a fixed alpha
  if (I.band) {
    const b = I.band, x = Math.min(b.x0, b.x1), y = Math.min(b.y0, b.y1), w = Math.abs(b.x1 - b.x0), h = Math.abs(b.y1 - b.y0);
    ctx.fillStyle = rgba(COL.cyan, 0.06); ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = rgba(COL.cyan, 0.8); ctx.lineWidth = 1; ctx.setLineDash(DASH_BAND);
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
    ctx.setLineDash(DASH_NONE);
  }
  if (I.tip.style.display !== 'none' || hovNode || I.hoverX || (I.kbTip && selNode)) updateTip();
}

// a PR: a small dark ring in its ship colour with a pull-request glyph inside; hollow while new work
// since the PR hasn't reached it (fresh)
function drawPr(ctx, n, ks) {
  const c = shipColor(n.ship), r = n.R;
  ctx.fillStyle = HOLE; circle(ctx, n.sx, n.sy, r); ctx.fill();
  if (!n.ship.fresh) { ctx.fillStyle = rgba(c, 0.2); circle(ctx, n.sx, n.sy, r); ctx.fill(); }
  ctx.strokeStyle = c; ctx.lineWidth = 1.4;
  if (n.ship.fresh) ctx.setLineDash(DASH_FRESH);
  circle(ctx, n.sx, n.sy, r - 0.7); ctx.stroke();
  ctx.setLineDash(DASH_NONE);
  if (r < 4.5) return;
  // glyph (a pull request): the base branch on the left, the PR's branch on the right curving into it
  // with an arrow head
  unit(ctx, n.sx, n.sy, r);
  ctx.strokeStyle = c; ctx.fillStyle = c; ctx.lineWidth = 1.2 / r;
  ctx.beginPath();
  ctx.moveTo(-0.3, -0.3); ctx.lineTo(-0.3, 0.3);
  ctx.moveTo(0.3, 0.26); ctx.lineTo(0.3, -0.12); ctx.quadraticCurveTo(0.3, -0.36, 0.04, -0.36);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(-0.1, -0.36); ctx.lineTo(0.1, -0.52); ctx.lineTo(0.1, -0.2); ctx.closePath();
  ctx.moveTo(-0.15, -0.42); ctx.arc(-0.3, -0.42, 0.15, 0, TAU);
  ctx.moveTo(-0.15, 0.42); ctx.arc(-0.3, 0.42, 0.15, 0, TAU);
  ctx.moveTo(0.45, 0.42); ctx.arc(0.3, 0.42, 0.15, 0, TAU);
  ctx.fill();
  screen(ctx);
  // shipping to the phones (the 'app' step): a small phone badge at the top right, in that step's colour
  const app = n.ship.steps.find(([nm]) => nm === 'app');
  if (app) {
    const pc = (STEP_LOOK[app[1]] || STEP_LOOK.none)[1], w = 4.2 * ks, h = 6.6 * ks, x = n.sx + r * 0.62, y = n.sy - r * 0.62 - h * 0.6;
    ctx.fillStyle = HOLE; roundRect(ctx, x - 1, y - 1, w + 2, h + 2, 2); ctx.fill();
    ctx.strokeStyle = pc; ctx.lineWidth = 1.1; roundRect(ctx, x, y, w, h, 1.3); ctx.stroke();
    ctx.fillStyle = pc; ctx.fillRect(x + w / 2 - 0.6, y + h - 1.9, 1.2, 0.9);
  }
}

// ---------- command center layers (see "Command center" at the top) ----------
// a node pair's curve (the same bend as edges and comets; flip: bent to the other side), as n + 1 points
function curvePts(a, b, n, flip) {
  const c = bend(a, b), cx = flip ? a.sx + b.sx - c.x : c.x, cy = flip ? a.sy + b.sy - c.y : c.y, pts = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n, f = 1 - u;
    pts.push([f * f * a.sx + 2 * f * u * cx + u * u * b.sx, f * f * a.sy + 2 * f * u * cy + u * u * b.sy]);
  }
  return pts;
}
// the shortest distance from a point to a polyline
function distPts(pts, x, y) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy || 1;
    const t = clamp(((x - x0) * dx + (y - y0) * dy) / l2, 0, 1);
    best = Math.min(best, Math.hypot(x - (x0 + t * dx), y - (y0 + t * dy)));
  }
  return best;
}
const onScreen = (n) => n && n.sx !== undefined && n.sy !== undefined;

// Teams: every pair of members (a ring around their middle past 4 members) tied by two strands that braid
// around the shared curve, in the team's colour at a fixed alpha. The crossings slide slowly along the link
// (motion only). The pill with the team's name sits at the link's middle (the members' middle for 3+); comets
// of a new order start there (a virtual comet end, 'T:<team id>'). A team with a lead: one spoke from the lead to
// each member instead (chain of command: they report to it, not to each other); its ★ badge is drawn over the
// nodes (drawLeadBadges). A spoke to a member that leads a team of its own (a mid-level lead: teams nest) is the
// level link: stronger and brighter, in the colour of the team above.
const LEVEL_ALPHA = 0.72;
function drawTeams(ctx, ks) {
  const N = 28, ph = I.still ? 0 : I.time / 2600;
  for (const tm of I.teams) {
    // the members here that lead the teams below this one
    const below = new Set(I.teams.filter((x) => x.up === tm).map((x) => x.lead));
    const ns = tm.members.map((id) => I.byId.get('s:' + id)).filter(onScreen);
    tm.pairs = []; tm.pill = null; tm.rect = null;
    if (ns.length < 2) continue;
    let mx = 0, my = 0;
    for (const n of ns) { mx += n.sx; my += n.sy; }
    mx /= ns.length; my /= ns.length;
    const hub = tm.lead ? ns.find((n) => n.sid === tm.lead) : null;
    if (hub) { for (const n of ns) if (n !== hub) tm.pairs.push([hub, n]); }
    else if (ns.length <= 4) { for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) tm.pairs.push([ns[i], ns[j]]); }
    else {
      const ring = ns.slice().sort((a, b) => Math.atan2(a.sy - my, a.sx - mx) - Math.atan2(b.sy - my, b.sx - mx));
      ring.forEach((n, i) => tm.pairs.push([n, ring[(i + 1) % ring.length]]));
    }
    const col = /^#[0-9a-f]{6}$/i.test(tm.t.color || '') ? tm.t.color : COL.violet;
    let mid = null;
    for (const [a, b] of tm.pairs) {
      const level = !!hub && below.has(b.sid);
      ctx.strokeStyle = rgba(col, level ? LEVEL_ALPHA : TEAM_ALPHA); ctx.lineWidth = level ? 1.7 : 1.1;
      const pts = curvePts(a, b, N);
      const d = Math.hypot(b.sx - a.sx, b.sy - a.sy), amp = Math.min(3.4 * ks, d * 0.05), tw = Math.max(2, Math.round(d / 60));
      for (const sg of [1, -1]) {
        ctx.beginPath();
        for (let i = 0; i <= N; i++) {
          const p0 = pts[Math.max(0, i - 1)], p1 = pts[Math.min(N, i + 1)];
          let nx = p0[1] - p1[1], ny = p1[0] - p0[0];
          const l = Math.hypot(nx, ny) || 1; nx /= l; ny /= l;
          const u = i / N, o = sg * amp * Math.sin(Math.PI * u) * Math.sin(Math.PI * tw * u - ph * TAU);
          const x = pts[i][0] + nx * o, y = pts[i][1] + ny * o;
          if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        }
        ctx.stroke();
      }
      if (!mid) mid = pts[N / 2];
      I.linkHits.push({ kind: 'team', id: tm.t.id, pts, mid: pts[N / 2] });
    }
    const pill = tm.pairs.length === 1 && mid ? mid : [mx, my];
    tm.pill = { x: pill[0], y: pill[1], color: col };
    I.virt.set('T:' + tm.t.id, { id: 'T:' + tm.t.id, kind: 'team', sx: pill[0], sy: pill[1], h: hashNum(tm.t.id), R: 0, RG: 0 });
  }
}

// A team's lead: a small ★ badge on its node's upper right, in the team's colour on a dark disc (steady: no motion).
// A mid-level lead's (it reports in a team above, tm.up) has a thin outer ring in that team's colour too.
function drawLeadBadges(ctx, ks) {
  for (const tm of I.teams) {
    if (!tm.lead) continue;
    const n = I.byId.get('s:' + tm.lead);
    if (!onScreen(n)) continue;
    const col = /^#[0-9a-f]{6}$/i.test(tm.t.color || '') ? tm.t.color : COL.violet;
    const r = 5.2 * ks, d = (n.RG || n.R) * (n.bs || 1) + r * 0.35, a = -Math.PI / 4;
    const x = n.sx + Math.cos(a) * d, y = n.sy + Math.sin(a) * d;
    if (tm.up) {
      const upCol = /^#[0-9a-f]{6}$/i.test(tm.up.t.color || '') ? tm.up.t.color : COL.violet;
      ctx.fillStyle = HOLE; circle(ctx, x, y, r + 1.8 * ks); ctx.fill();
      ctx.strokeStyle = rgba(upCol, 0.85); ctx.lineWidth = 1.2; circle(ctx, x, y, r + 1.2 * ks); ctx.stroke();
    }
    ctx.fillStyle = HOLE; circle(ctx, x, y, r); ctx.fill();
    ctx.strokeStyle = rgba(col, 0.75); ctx.lineWidth = 1; ctx.stroke();
    starPath(ctx, x, y + 0.2 * ks, r * 0.72, r * 0.3); ctx.fillStyle = col; ctx.fill();
  }
}
function starPath(ctx, x, y, ro, ri) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? ri : ro;
    if (i) ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); else ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
  }
  ctx.closePath();
}

// Parity partners: a thin dotted line from the web side (cyan) to the app side (mint), fixed alpha. It bends to
// the other side than the pair's usual curve, which a team's braid (partners are often a team) takes.
const PAR_EDGE = buildEdge(PARITY_ALPHA);
function drawParity(ctx, ks) {
  for (const p of I.parity) {
    const a = I.byId.get(p.a), b = I.byId.get(p.b);
    if (!onScreen(a) || !onScreen(b)) continue;
    const dx = b.sx - a.sx, dy = b.sy - a.sy, d = Math.hypot(dx, dy);
    if (d < 4) continue;
    const s = -bendAmt(a, b, d) / d, q = I.dpr;
    ctx.setTransform(q * dx, q * dy, -q * dy, q * dx, q * a.sx, q * a.sy);
    ctx.strokeStyle = cache('par', COL.cyan, COL.mint, PAR_EDGE);
    ctx.lineWidth = (1.6 * ks) / d; ctx.setLineDash([0.01 / d, (4.2 * ks) / d]);
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.quadraticCurveTo(0.5, s, 1, 0); ctx.stroke();
    ctx.setLineDash(DASH_NONE);
    screen(ctx);
    const pts = curvePts(a, b, 20, true);
    I.linkHits.push({ kind: 'parity', id: p.a + '|' + p.b, pts, mid: pts[10], a, b });
  }
}

// Handoff trails: a faint line from the conversation it was picked up from, with a small arrow at its end.
function drawTrails(ctx, ks) {
  for (const t of I.trails) {
    const a = I.byId.get(t.a), b = I.byId.get(t.b);
    if (!onScreen(a) || !onScreen(b)) continue;
    const pts = curvePts(a, b, 20);
    ctx.strokeStyle = rgba(COL.dim, TRAIL_ALPHA); ctx.lineWidth = 1;
    curve(ctx, a, b);
    // the arrow: just outside the target's ring, along the curve's end
    const c = bend(a, b), tx = b.sx - c.x, ty = b.sy - c.y, tl = Math.hypot(tx, ty) || 1, ux = tx / tl, uy = ty / tl;
    const back = (b.RG || b.R || 6) + 3 * ks, hx = b.sx - ux * back, hy = b.sy - uy * back, al = 5 * ks, aw = 2.8 * ks;
    ctx.fillStyle = rgba(COL.dim, TRAIL_ALPHA * 1.8);
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx - ux * al - uy * aw, hy - uy * al + ux * aw); ctx.lineTo(hx - ux * al + uy * aw, hy - uy * al - ux * aw); ctx.closePath(); ctx.fill();
    I.linkHits.push({ kind: 'handoff', id: t.a + '>' + t.b, pts, mid: pts[10], a, b });
  }
}

// A one-sided change in a parity repo: a small hollow ghost orb beside the conversation (past its agents),
// on a dashed line, for the side it didn't change. Fixed alpha.
function drawParityGhosts(ctx, k, ks) {
  for (const n of I.nodes) {
    if (n.kind !== 'session' || n.fin || n.s.pending || !n.s.parity || !n.s.parity.missing || !onScreen(n)) continue;
    const miss = n.s.parity.missing, col = miss === 'app' ? COL.mint : COL.cyan;
    const hub = I.byId.get(n.cl);
    let vx = 1, vy = 0;
    if (onScreen(hub)) { vx = n.sx - hub.sx; vy = n.sy - hub.sy; const l = Math.hypot(vx, vy) || 1; vx /= l; vy /= l; }
    // turned 40 degrees off the line from the hub, so it doesn't sit on the name underneath
    const c = Math.cos(-0.7), s = Math.sin(-0.7), dx = vx * c - vy * s, dy = vx * s + vy * c;
    const out = (n.agents.length ? Math.max(32 * k, n.RG + 10 * ks) + 3.6 * ks : n.RG) + 14 * ks, r = 5 * ks;
    const x = n.sx + dx * out, y = n.sy + dy * out;
    ctx.strokeStyle = rgba(col, 0.5); ctx.lineWidth = 1; ctx.setLineDash(DASH_GHOST);
    line(ctx, n.sx + dx * (n.RG + 2), n.sy + dy * (n.RG + 2), x - dx * (r + 1.5), y - dy * (r + 1.5));
    ctx.fillStyle = HOLE; circle(ctx, x, y, r); ctx.fill();
    ctx.fillStyle = rgba(col, 0.1); ctx.fill();
    ctx.strokeStyle = rgba(col, 0.75); ctx.lineWidth = 1.2; circle(ctx, x, y, r - 0.6); ctx.stroke();
    ctx.setLineDash(DASH_NONE);
    I.parGhosts.push({ n, x, y, r, missing: miss, col });
  }
}

// A conflict node: a ring with a branch glyph (two conversations on one branch, gold), a folder glyph (two live
// in one worktree, red), or a '#nnn' tag (two migrations with one number, red).
function drawConflict(ctx, n, ks) {
  const k = n.k, c = conflictColor(k), r = n.R;
  if (k.kind === 'migration') {
    const f = font(10, 700, MONO), t = String(k.label || '').startsWith('#') ? k.label : '#' + (k.label || '?');
    const sf = I.sf || 1, w = measure(ctx, f, t) + 10 * sf, h = 15 * sf, x = n.sx - w / 2, y = n.sy - h / 2;
    ctx.fillStyle = HOLE; roundRect(ctx, x, y, w, h, h / 2); ctx.fill();
    ctx.fillStyle = rgba(c, 0.16); ctx.fill();
    ctx.strokeStyle = c; ctx.lineWidth = 1.3; roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, h / 2 - 0.5); ctx.stroke();
    ctx.font = f; ctx.fillStyle = c; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(t, n.sx, n.sy + 0.5);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    n.RG = w / 2;
    return;
  }
  ctx.fillStyle = HOLE; circle(ctx, n.sx, n.sy, r); ctx.fill();
  ctx.fillStyle = rgba(c, 0.16); ctx.fill();
  ctx.strokeStyle = c; ctx.lineWidth = 1.4; circle(ctx, n.sx, n.sy, r - 0.7); ctx.stroke();
  unit(ctx, n.sx, n.sy, r);
  ctx.strokeStyle = c; ctx.fillStyle = c; ctx.lineWidth = 1.2 / r;
  ctx.beginPath();
  if (k.kind === 'branch') {
    // a branch: the trunk on the left, a branch curving off it to the right
    ctx.moveTo(-0.28, -0.42); ctx.lineTo(-0.28, 0.42);
    ctx.moveTo(0.3, -0.24); ctx.quadraticCurveTo(0.3, 0.12, -0.28, 0.2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-0.13, -0.46); ctx.arc(-0.28, -0.46, 0.15, 0, TAU);
    ctx.moveTo(-0.13, 0.46); ctx.arc(-0.28, 0.46, 0.15, 0, TAU);
    ctx.moveTo(0.45, -0.34); ctx.arc(0.3, -0.34, 0.15, 0, TAU);
    ctx.fill();
  } else {
    // a folder
    ctx.moveTo(-0.5, -0.34); ctx.lineTo(-0.16, -0.34); ctx.lineTo(-0.04, -0.2); ctx.lineTo(0.5, -0.2);
    ctx.lineTo(0.5, 0.38); ctx.lineTo(-0.5, 0.38); ctx.closePath();
    ctx.moveTo(-0.5, -0.06); ctx.lineTo(0.5, -0.06);
    ctx.stroke();
  }
  screen(ctx);
}

// worktree satellites on a hub's outer ring (fixed slots from the top, no motion), small filled rounded squares so
// they read apart from the round conversation satellites and agents; only worktrees a live conversation works in
function drawWorktrees(ctx, n, r, ks) {
  const list = n.wtsLive;
  if (!list || !list.length) return;
  const m = Math.min(list.length, WT_MAX), R = r * WT_RING, sr = 2.3 * ks, hue = n.color || COL.dim;
  for (let i = 0; i < m; i++) {
    const w = list[i], a = -Math.PI / 2 + (i - (m - 1) / 2) * (TAU / Math.max(m, 8));
    const x = n.sx + Math.cos(a) * R, y = n.sy + Math.sin(a) * R;
    ctx.fillStyle = HOLE; roundRect(ctx, x - sr - 1, y - sr - 1, 2 * sr + 2, 2 * sr + 2, 1.6); ctx.fill();
    ctx.fillStyle = hue; roundRect(ctx, x - sr, y - sr, 2 * sr, 2 * sr, 1.2); ctx.fill();
    I.wtHits.push({ w, x, y, r: sr, hub: n });
  }
}

// Comets: a head dot at constant brightness and a six-dot tail that thins toward the edge colour. They
// ride the drawn curve, so they follow drifting nodes; the tail slides into the target and is gone. When the
// head reaches its target, a repo or a conversation there gets a small bump (arrive). Comets that end at a
// repo are drawn in a second pass (late), over the hub, and fade out as they sink into its core. A merge's
// comet (big) is slower, with a larger head and a BIG_TAIL-dot tail; its landing spins the hub (landed).
function drawComets(ctx, ks, late) {
  const now = performance.now();
  if (!late) {
    const q = I.cometQ;
    while (q.length && q[0].at <= now) {
      const c = q.shift();
      if (now - c.at > 1000) continue; // queued while the map was hidden: history now
      // once per comet, not per frame: its trip, tail and colours (head, then tail dots fixed per index, thinning
      // toward the edge's alpha)
      c.ms = c.big ? BIG_MS : COMET_MS; c.tail = c.big ? BIG_TAIL : COMET_TAIL; c.gap = c.big ? BIG_GAP : COMET_GAP;
      c.cols = [c.hue];
      for (let j = 1; j <= c.tail; j++) c.cols.push(rgba(c.hue, c.big ? 0.82 - (0.7 * (j - 1)) / (c.tail - 1) : 0.7 - (0.55 * (j - 1)) / (c.tail - 1)));
      I.comets.push(c);
    }
    if (I.comets.length > COMET_MAX) I.comets.splice(0, I.comets.length - COMET_MAX);
    let keep = 0;
    for (let i = 0; i < I.comets.length; i++) {
      const c = I.comets[i];
      const u = (now - c.at) / c.ms;
      const a = cometNode(c.a), b = cometNode(c.b);
      if (u > 1 + c.tail * c.gap || !a || !b || a.sx === undefined || b.sx === undefined) continue;
      I.comets[keep++] = c;
      c.into = b.kind === 'repo';
      if (u >= 1 && !c.hit) { c.hit = true; arrive(b, now); if (c.big) landed(b, now); }
    }
    I.comets.length = keep;
  }
  const W = I.W, H = I.H;
  for (const c of I.comets) {
    if (!!c.into !== late) continue;
    const u = (now - c.at) / c.ms;
    if (u < 0) continue;
    const a = cometNode(c.a), b = cometNode(c.b);
    // both ends off screen on the same side: nothing of it shows
    if ((a.sx < 0 && b.sx < 0) || (a.sx > W && b.sx > W) || (a.sy < 0 && b.sy < 0) || (a.sy > H && b.sy > H)) continue;
    const cp = bend(a, b), cx = cp.x, cy = cp.y;
    const sink = late ? b.R * 1.25 : 0; // within this distance of the hub's centre a dot fades out
    const glow = glowImage(c.hue), gr = (c.big ? BIG_HEAD * BIG_GLOW_R : 2.6 * GLOW_R) * ks;
    for (let j = c.tail; j >= 0; j--) {
      const v = u - j * c.gap;
      if (v < 0 || (j === 0 && v > 1)) continue;
      const e = ease(v > 1 ? 1 : v), f = 1 - e;
      const x = f * f * a.sx + 2 * f * e * cx + e * e * b.sx, y = f * f * a.sy + 2 * f * e * cy + e * e * b.sy;
      if (sink) {
        const d = Math.hypot(x - b.sx, y - b.sy);
        if (d < 0.5) continue;
        ctx.globalAlpha = d < sink ? d / sink : 1;
      }
      // its glow first, added light ('lighter') so it brightens the edge and sky under it without hiding them
      if (j <= GLOW_TAIL) {
        const fade = ctx.globalAlpha, r = j ? gr * GLOW_TAIL_R : gr;
        ctx.globalAlpha = fade * GLOW_A * GLOW_FALL ** j;
        ctx.globalCompositeOperation = 'lighter';
        ctx.drawImage(glow, x - r, y - r, 2 * r, 2 * r);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = fade;
      }
      ctx.fillStyle = c.cols[j];
      circle(ctx, x, y, (c.big ? (j === 0 ? BIG_HEAD : 3 - j * 0.14) : j === 0 ? 2.6 : 2 - j * 0.15) * ks);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

// a comet's glow: a radial falloff in its hue, drawn once per hue into a small sprite (scaled by drawImage, so no
// gradient is built per frame and zoom needs no new one); a few dozen hues at most, cleared if it ever grows past that
function glowImage(hue) {
  const G = I.glowImg || (I.glowImg = new Map());
  let c = G.get(hue);
  if (c) return c;
  if (G.size > 48) G.clear();
  c = document.createElement('canvas');
  c.width = c.height = GLOW_PX;
  const g = c.getContext('2d'), h = GLOW_PX / 2, gr = g.createRadialGradient(h, h, 0, h, h, h);
  gr.addColorStop(0, rgba(hue, 1)); gr.addColorStop(0.18, rgba(hue, 0.6)); gr.addColorStop(0.45, rgba(hue, 0.2));
  gr.addColorStop(0.75, rgba(hue, 0.05)); gr.addColorStop(1, rgba(hue, 0));
  g.fillStyle = gr; g.fillRect(0, 0, GLOW_PX, GLOW_PX);
  G.set(hue, c);
  return c;
}

// for tests: each comet's head on screen now (CSS px of the map), as drawComets places it
function cometHeads() {
  const now = performance.now(), out = [];
  for (const c of I.comets) {
    const u = (now - c.at) / c.ms, a = cometNode(c.a), b = cometNode(c.b);
    if (u < 0 || u > 1 || !a || !b) continue;
    const cp = bend(a, b), e = ease(u), f = 1 - e;
    out.push({ x: Math.round(f * f * a.sx + 2 * f * e * cp.x + e * e * b.sx), y: Math.round(f * f * a.sy + 2 * f * e * cp.y + e * e * b.sy), big: !!c.big, u: Math.round(u * 100) / 100 });
  }
  return out;
}

// a comet's end: a node, or a team's pill ('T:<team id>', placed each frame in drawTeams)
function cometNode(id) { return I.byId.get(id) || I.virt.get(id) || null; }

// A merge's sparks (I.bursts): SPARKS dots in the repo's colour (every other one a lighter tint, smaller and not as
// far) fly out of the hub, easing out to SPARK_REACH of its radius while the ring curls SPARK_CURL round. Each
// spark shrinks to nothing on the way, its short streak (round caps, as draw sets) shortening as it slows; alpha
// never moves.
function drawBursts(ctx, ks) {
  if (!I.bursts.length) return;
  const now = performance.now(), W = I.W, H = I.H;
  let keep = 0;
  for (const b of I.bursts) {
    const u = (now - b.at) / SPARK_MS, n = I.byId.get(b.id);
    if (u >= 1 || !n || n.sx === undefined) continue;
    I.bursts[keep++] = b;
    if (u < 0) continue;
    const r0 = n.R * 1.3, reach = n.R * SPARK_REACH;
    if (n.sx + reach < 0 || n.sx - reach > W || n.sy + reach < 0 || n.sy - reach > H) continue;
    if (!b.cols) b.cols = [b.hue, mixHex(b.hue, '#ffffff', 0.45)];
    const e = 1 - Math.pow(1 - u, 3), speed = 3 * (1 - u) * (1 - u), size = SPARK_R * ks * (1 - u);
    for (let i = 0; i < SPARKS; i++) {
      const odd = i & 1, sr = size * (odd ? 0.7 : 1);
      if (sr < 0.25) continue;
      const a = b.rot + (i * TAU) / SPARKS + SPARK_CURL * e, ca = Math.cos(a), sa = Math.sin(a);
      const span = reach * (odd ? 0.78 : 1) - r0, d = r0 + span * e, tl = Math.min(d - r0, span * 0.14 * speed);
      ctx.fillStyle = ctx.strokeStyle = b.cols[odd];
      if (tl > sr) {
        // the streak points back along the path it came (a little round the curl too)
        const ab = a - SPARK_CURL * 0.14 * speed;
        ctx.lineWidth = sr * 1.3;
        ctx.beginPath(); ctx.moveTo(n.sx + Math.cos(ab) * (d - tl), n.sy + Math.sin(ab) * (d - tl)); ctx.lineTo(n.sx + ca * d, n.sy + sa * d); ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(n.sx + ca * d, n.sy + sa * d, sr, 0, TAU); ctx.fill();
    }
  }
  I.bursts.length = keep;
}

// ---------- reactions: motion only ----------
// I.react: node id -> { bump: when its last scale bump started, kT: ring rotation asked for by kicks, kC: eased so far }
function reactOf(id) {
  const R = I.react || (I.react = new Map());
  let r = R.get(id);
  if (!r) R.set(id, (r = { bump: -Infinity, kT: 0, kC: 0, hits: 0, bumps: 0, whirl: -Infinity, whirls: 0 }));
  return r;
}
function arrive(n, now) {
  if (!n || (n.kind !== 'repo' && n.kind !== 'session') || I.still) return;
  const r = reactOf(n.id);
  r.hits++;
  // a burst never stacks into a jitter: one bump per BUMP_GAP; the ring's kicks add up and ease in together
  if (now - r.bump >= BUMP_GAP) { r.bump = now; r.bumps++; }
  if (n.kind === 'repo') r.kT += KICK;
}
// a merge lands on a hub (at may be ahead): one extra full turn of its ring, a bump, a ring of sparks and a meteor
// shower above it (unless one fell in the last SHOWER_GAP)
function landed(n, at) {
  if (!n || n.kind !== 'repo' || I.still) return;
  const r = reactOf(n.id);
  r.whirl = at; r.whirls++;
  if (r.bump !== at) { r.bump = at; r.bumps++; }
  I.bursts.push({ id: n.id, at, hue: n.color || COL.dim, rot: hashNum(n.id + at) * TAU });
  if (I.bursts.length > 12) I.bursts.shift();
  shower(at, n);
}
// the ring's extra turn while a landing's whirl runs (0 before and after: a full turn ends where it began)
function whirlOf(r, now) {
  const u = r ? (now - r.whirl) / WHIRL_MS : -1;
  if (!(u > 0 && u < 1)) return 0;
  I.quick = true;
  return TAU * (1 - Math.pow(1 - u, 3));
}
// 1 -> 1 + BUMP_UP -> 1 over BUMP_MS: a quick rise, then an ease-out back
function bumpScale(id, now) {
  const r = I.react && I.react.get(id);
  if (!r) return 1;
  const u = (now - r.bump) / BUMP_MS;
  if (!(u >= 0 && u < 1)) return 1;
  I.quick = true;
  const shape = u < 0.22 ? Math.sin((u / 0.22) * (Math.PI / 2)) : Math.pow(1 - (u - 0.22) / 0.78, 3);
  return 1 + BUMP_UP * shape;
}

// A repo hub: a faceted hexagon core with a soft gradient in the repo colour, a ring of HUB_SEGS arcs turning
// once per HUB_TURN_MS (plus any eased kicks), and three satellite ticks riding the ring's gaps. Drawn in unit
// space (the core's radius is 1), so one cached gradient serves every hub of a colour at any size.
const HEX = Array.from({ length: 6 }, (_, i) => [Math.cos(-Math.PI / 2 + (i * Math.PI) / 3), Math.sin(-Math.PI / 2 + (i * Math.PI) / 3)]);
function hexPath(ctx, s) {
  ctx.moveTo(HEX[0][0] * s, HEX[0][1] * s);
  for (let i = 1; i < 6; i++) ctx.lineTo(HEX[i][0] * s, HEX[i][1] * s);
  ctx.closePath();
}
function facets(ctx, list) {
  ctx.beginPath();
  for (const i of list) { const a = HEX[i], b = HEX[(i + 1) % 6]; ctx.moveTo(0, 0); ctx.lineTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.closePath(); }
}
const buildGem = (c, hue) => mix(hue, WHITE, 0.5);
const buildHalo = (c, hue) => {
  const g = c.createRadialGradient(0, 0, 0, 0, 0, 1);
  g.addColorStop(0, rgba(hue, HUB_HALO_ALPHA)); g.addColorStop(0.45, rgba(hue, HUB_HALO_ALPHA * 0.45)); g.addColorStop(1, rgba(hue, 0));
  return g;
};
// a repo's eased presence (1 while it has a live conversation), activity (how many work, up to 3), its ring's
// spin and orbit phase, and its satellites (one per live conversation, sid -> { lv, b, a, hue })
function hubOf(n, now) {
  let H = I.hub.get(n.id);
  const live = [];
  let busy = 0;
  for (const s of n.sessions) { if (s.state === 'DONE') continue; live.push(s); if (BUSY.has(s.state)) busy++; }
  if (!H) {
    H = { pres: live.length ? 1 : 0, act: Math.min(busy, 3), spin: hashNum(n.id) * TAU, orb: hashNum(n.id + 'o') * TAU, sats: new Map(), grow: 1,
      born: !I.still && !I.replay && I.lastDraw && now - I.lastDraw < 1500 ? now : -Infinity };
    I.hub.set(n.id, H);
  }
  H.pres = glide(H.pres, live.length ? 1 : 0, 900);
  H.act = glide(H.act, Math.min(busy, 3), 1200);
  if (!I.still) {
    const dt = I.adt ?? 16, a1 = Math.min(1, H.act);
    // dormant: a slow turn; working: up to twice as fast with more conversations at work
    H.spin = (H.spin + ((TAU * dt) / HUB_TURN_MS) * (0.3 + 0.7 * a1 + 0.5 * Math.max(0, H.act - 1))) % (TAU * 64);
    H.orb = (H.orb + ((TAU * dt) / SAT_TURN_MS) * (0.4 + 0.6 * a1)) % TAU;
  }
  if (H.act > 0.05) I.lively = true; // its ring turns fast
  const u = (now - H.born) / BIRTH_MS;
  H.grow = u >= 0 && u < 1 ? backOut(u) : 1;
  if (H.grow !== 1) I.quick = true;
  // satellites: live conversations on even slots (by id, so they keep their order), eased in and out
  live.sort((x, y) => (x.id < y.id ? -1 : 1));
  const m = Math.min(live.length, SAT_MAX), want = new Set();
  for (let i = 0; i < m; i++) {
    const s = live[i];
    want.add(s.id);
    let sat = H.sats.get(s.id);
    const slot = (i / m) * TAU;
    if (!sat) H.sats.set(s.id, (sat = { lv: 0, b: BUSY.has(s.state) ? 1 : 0, a: slot }));
    sat.hue = s.hue || COL.cyan; sat.slot = slot;
    sat.b = glide(sat.b, BUSY.has(s.state) ? 1 : 0, 600);
  }
  for (const [sid, sat] of H.sats) {
    sat.lv = glide(sat.lv, want.has(sid) ? 1 : 0, 550);
    if (!want.has(sid) && sat.lv < 0.02) { H.sats.delete(sid); continue; }
    if (want.has(sid)) {
      let d = sat.slot - sat.a; d = Math.atan2(Math.sin(d), Math.cos(d));
      sat.a = I.still || Math.abs(d) < 0.002 ? sat.slot : sat.a + d * (1 - Math.exp(-(I.dt || 16) / 260));
      if (sat.a !== sat.slot) I.quick = true;
    }
  }
  return H;
}
// the repo's initial for the hub's core: its first letter or digit
const initial = (name) => { const m = String(name || '').match(/[\p{L}\p{N}]/u); return m ? m[0].toUpperCase() : ''; };

// A repo hub (see "Look" at the top). Drawn in unit space (the core's radius is 1), so one cached gradient
// serves every hub of a colour at any size. An arriving comet's eased kicks add to the ring's spin.
function drawHub(ctx, n) {
  const hue = n.color || COL.dim, r = n.R * (n.bs || 1);
  const H = I.hub.get(n.id) || { pres: 0, act: 0, spin: 0, orb: 0, sats: new Map() };
  const rr = I.react && I.react.get(n.id);
  if (rr && rr.kC !== rr.kT) {
    I.quick = true;
    rr.kC += (rr.kT - rr.kC) * (1 - Math.exp(-(I.dt || 16) / KICK_EASE_MS));
    if (Math.abs(rr.kT - rr.kC) < 1e-3) rr.kC = rr.kT;
    if (rr.kC > TAU * 64) { rr.kC -= TAU * 64; rr.kT -= TAU * 64; }
  }
  const spin = H.spin + (rr ? rr.kC + whirlOf(rr, I.nowP) : 0), pres = H.pres, act = Math.min(1, H.act);
  n.spin = spin; n.da = ctx.globalAlpha;
  // the halo: a soft glow whose SIZE grows with presence and work (its alpha is fixed)
  const hr = r * (1.7 + 1.5 * pres + 0.5 * (Math.min(H.act, 3) / 3));
  unit(ctx, n.sx, n.sy, hr);
  ctx.fillStyle = cache('hubHalo', hue, '', buildHalo);
  ctx.beginPath(); ctx.arc(0, 0, 1, 0, TAU); ctx.fill();
  unit(ctx, n.sx, n.sy, r);
  // the ring of arcs (longer and thicker while live), and ticks in every other gap
  const seg = TAU / HUB_SEGS, span = seg * (0.3 + 0.36 * pres);
  ctx.strokeStyle = rgba(hue, 0.66); ctx.lineWidth = (1.1 + 0.6 * pres) / r;
  ctx.beginPath();
  for (let i = 0; i < HUB_SEGS; i++) {
    const a0 = spin + i * seg;
    ctx.moveTo(Math.cos(a0) * HUB_RING, Math.sin(a0) * HUB_RING); ctx.arc(0, 0, HUB_RING, a0, a0 + span);
  }
  ctx.stroke();
  const tick = HUB_RING + 0.12 + (HUB_TICKS - HUB_RING - 0.12) * (0.45 + 0.55 * pres);
  ctx.strokeStyle = rgba(hue, 0.5); ctx.lineWidth = 1.2 / r;
  ctx.beginPath();
  for (let i = 0; i < HUB_SEGS; i += 2) {
    const a = spin + i * seg + span + (seg - span) / 2, ca = Math.cos(a), sa = Math.sin(a);
    ctx.moveTo(ca * (HUB_RING + 0.12), sa * (HUB_RING + 0.12)); ctx.lineTo(ca * tick, sa * tick);
  }
  ctx.stroke();
  // at work: a fine inner ring of dashes turning the other way, its dashes growing out of nothing
  if (act > 0.02) {
    const ir = 1.24, dl = 0.2 * act;
    ctx.strokeStyle = rgba(hue, 0.55); ctx.lineWidth = 1 / r;
    ctx.beginPath();
    for (let i = 0; i < 12; i++) {
      const a0 = -spin * 1.6 + (i * TAU) / 12;
      ctx.moveTo(Math.cos(a0) * ir, Math.sin(a0) * ir); ctx.arc(0, 0, ir, a0, a0 + dl);
    }
    ctx.stroke();
  }
  // the satellites' faint track
  if (pres > 0.02 && H.sats.size) {
    ctx.strokeStyle = rgba(hue, 0.14); ctx.lineWidth = (0.9 * pres) / r;
    ctx.beginPath(); ctx.arc(0, 0, SAT_RING, 0, TAU); ctx.stroke();
  }
  // the core: a gradient hexagon, lit facets top left, shaded facets bottom right
  ctx.fillStyle = cache('hub', hue, '', buildDiamond);
  ctx.beginPath(); hexPath(ctx, 1); ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.12)'; facets(ctx, [4, 5]); ctx.fill();
  ctx.fillStyle = 'rgba(5,7,13,0.22)'; facets(ctx, [1, 2]); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.24)'; ctx.lineWidth = 1 / r;
  ctx.beginPath(); hexPath(ctx, 1 - 0.5 / r); ctx.stroke();
  screen(ctx);
  // the repo's initial on the core when there's room for it, else a small light gem
  const ch = r >= 6.5 ? initial(n.name) : '';
  if (ch) {
    ctx.font = `700 ${Math.round(r * 1.05)}px ${DISPLAY}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 2.2; ctx.strokeStyle = 'rgba(5,7,13,0.5)'; ctx.strokeText(ch, n.sx, n.sy + r * 0.06);
    ctx.fillStyle = 'rgba(255,255,255,0.96)'; ctx.fillText(ch, n.sx, n.sy + r * 0.06);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  } else {
    unit(ctx, n.sx, n.sy, r);
    ctx.fillStyle = cache('hubGem', hue, '', buildGem);
    ctx.beginPath(); hexPath(ctx, 0.34); ctx.fill();
    screen(ctx);
  }
  // satellites: one per live conversation in its colour, larger while it works, growing in and shrinking out
  const ks = ksOf(I.k);
  for (const sat of H.sats.values()) {
    const sr = ks * (1.8 + 0.9 * sat.b) * sat.lv;
    if (sr < 0.3) continue;
    const a = H.orb + sat.a, R = r * SAT_RING;
    ctx.fillStyle = HOLE; circle(ctx, n.sx + Math.cos(a) * R, n.sy + Math.sin(a) * R, sr + 1); ctx.fill();
    ctx.fillStyle = sat.hue; circle(ctx, n.sx + Math.cos(a) * R, n.sy + Math.sin(a) * R, sr); ctx.fill();
  }
  drawWorktrees(ctx, n, r, ks);
}

// A repo's production deploy (Vercel) on its hub: a small triangle badge at its upper right, gold while a
// build runs, mint when Vercel is clean (nothing building, the last deploy live), red when the last one failed.
// Building also sweeps a gold arc round the hub on a faint track, one turn per DEPLOY_TURN_MS (motion only; with
// reduced motion the arc stands still); failed draws a thin red ring. Repos that don't deploy get nothing.
const DEPLOY_TURN_MS = 1500;
function drawDeploy(ctx, n, ks) {
  const dp = I.deploy && I.deploy.get(n.id);
  if (!dp) return;
  screen(ctx);
  const c = dp.state === 'building' ? COL.gold : dp.state === 'failed' ? COL.red : COL.mint;
  const ro = (n.RO || n.RG || n.R) * (n.bs || 1) + 3.5 * ks;
  if (dp.state === 'building') {
    ctx.lineWidth = 2 * ks;
    ctx.strokeStyle = rgba(COL.gold, 0.16); circle(ctx, n.sx, n.sy, ro); ctx.stroke();
    const a = (I.time / DEPLOY_TURN_MS) * TAU;
    ctx.strokeStyle = COL.gold; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(n.sx, n.sy, ro, a, a + TAU * 0.28); ctx.stroke();
    ctx.lineCap = 'butt';
  } else if (dp.state === 'failed') {
    ctx.lineWidth = 1.4 * ks; ctx.strokeStyle = rgba(COL.red, 0.55); circle(ctx, n.sx, n.sy, ro); ctx.stroke();
  }
  const ba = -Math.PI / 4, bx = n.sx + Math.cos(ba) * ro, by = n.sy + Math.sin(ba) * ro, br = 5.4 * ks;
  ctx.fillStyle = HOLE; circle(ctx, bx, by, br + 1.6); ctx.fill();
  ctx.lineWidth = 1; ctx.strokeStyle = rgba(c, 0.55); circle(ctx, bx, by, br + 1.6); ctx.stroke();
  const t = br * 0.66;
  ctx.fillStyle = c; ctx.beginPath();
  ctx.moveTo(bx, by - t); ctx.lineTo(bx + t * 1.05, by + t * 0.68); ctx.lineTo(bx - t * 1.05, by + t * 0.68); ctx.closePath(); ctx.fill();
}

// conversations that just left the map: drawn where they were, shrinking as their opacity falls to 0 over
// GHOST_MS (a fade by age, nothing brightens). Their world position is kept, so they follow a pan or zoom.
function drawGhosts(ctx, ks) {
  if (!I.ghosts.length) return;
  const now = performance.now(), k = K();
  const ox = I.W / 2 - (I.cam.cx + I.pan.x) * k, oy = I.H / 2 - (I.cam.cy + I.pan.y) * k;
  I.ghosts = I.ghosts.filter((g) => now - g.at < (g.to ? HANDOFF_GHOST_MS : GHOST_MS));
  for (const g of I.ghosts) {
    const n = g.n;
    if (n.p) { n.sx = n.p.x * k + ox; n.sy = n.p.y * k + oy; }
    const tgt = g.to && I.byId.get(g.to);
    if (tgt && tgt.sx !== undefined) { handoffGhost(ctx, g, n, tgt, now, ks); continue; }
    const u = clamp((now - g.at) / GHOST_MS, 0, 1);
    n.R = n.fin ? FIN_R * ks : sessionRadius(n.s, ks); n.RG = n.R + (n.fin ? 2.5 : 4.5) * ks; n.bs = 1 - 0.45 * ease(u);
    ctx.globalAlpha = 1 - ease(u);
    drawSession(ctx, n, ks, false, false);
    ctx.globalAlpha = 1;
  }
}

// a handed-off conversation on its way into its pickup: it lifts off its spot, curves over to the new node
// (shrinking, a fading violet trail behind it) and sinks into it, which takes a brief violet halo
function handoffGhost(ctx, g, n, tgt, now, ks) {
  const u = clamp((now - g.at) / HANDOFF_GHOST_MS, 0, 1), m = ease(u);
  const x0 = n.sx, y0 = n.sy, x1 = tgt.sx, y1 = tgt.sy;
  // a gentle arc: the control point sits off the straight line by a fifth of its length
  const dx = x1 - x0, dy = y1 - y0, cx = (x0 + x1) / 2 - dy * 0.2, cy = (y0 + y1) / 2 + dx * 0.2;
  const at = (t) => [(1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * cx + t * t * x1, (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * cy + t * t * y1];
  const ga = ctx.globalAlpha;
  // trail: a few dots behind the head, fainter toward the start
  for (let i = 1; i <= 6; i++) {
    const t = m - i * 0.045;
    if (t <= 0) break;
    const [tx, ty] = at(t);
    ctx.globalAlpha = ga * (1 - u) * (0.5 - i * 0.07);
    ctx.fillStyle = COL.violet; circle(ctx, tx, ty, (3.2 - i * 0.35) * ks); ctx.fill();
  }
  const [hx, hy] = at(m);
  n.R = n.fin ? FIN_R * ks : sessionRadius(n.s, ks); n.RG = n.R + 4.5 * ks; n.bs = 1 - 0.7 * m;
  const sx = n.sx, sy = n.sy;
  n.sx = hx; n.sy = hy;
  ctx.globalAlpha = ga * (1 - m * m);
  drawSession(ctx, n, ks, false, false);
  n.sx = sx; n.sy = sy;
  // the pickup's halo as the old one arrives
  if (u > 0.55) {
    const v = (u - 0.55) / 0.45;
    ctx.globalAlpha = ga * 0.55 * (1 - v);
    ctx.strokeStyle = COL.violet; ctx.lineWidth = 2 * ks;
    circle(ctx, x1, y1, (tgt.R || 10 * ks) + (4 + 14 * ease(v)) * ks); ctx.stroke();
  }
  ctx.globalAlpha = ga;
}

function line(ctx, x0, y0, x1, y1) { ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke(); }
function circle(ctx, x, y, r) { ctx.beginPath(); ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2); }
function cross(ctx, x, y, r) { ctx.beginPath(); ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); ctx.stroke(); }

// A conversation's look key: what drawLook draws for it. WORKING and AGENTS look the same.
// In a lens other than 'state' a live conversation is an orb in the lens's colour ('L:<lens>').
const lookKey = (s) => (s.handing ? 'HANDOFF' : s.pending ? 'NEW' : I && I.lens !== 'state' && s.state !== 'DONE' ? 'L:' + I.lens
  : BUSY.has(s.state) ? 'BUSY' : s.state);
// the cost lens: the orb's size follows its cost ($0 .. $50, log scale)
const costRadius = (s) => 6 + 9 * costT(s.cost);
const gaugeOn = (s) => !s.pending && !s.handing && s.state !== 'DONE' && ctxPct(s) !== null;
// exponential easing toward want with time constant tau (ms); reduced motion snaps
function glide(cur, want, tau) {
  if (I.still || cur === undefined) return want;
  const v = cur + (want - cur) * (1 - Math.exp(-(I.dt || 16) / tau));
  if (Math.abs(want - v) < 1e-3) return want;
  I.quick = true; // still gliding: full rate until it is there
  return v;
}
// A conversation's look and its eased levels, updated once per frame:
//   key, prev, at  the look it shows, the one it morphs from and when that started (MORPH_MS)
//   rb             radius at ks 1, gliding to the state's size
//   busy           1 while it works: the ring of dots' size, and its speed (ringA advances by it)
//   live           1 until it's done: its link to the repo
//   g, frac        the memory gauge's thickness and its filled fraction
//   grow           its birth scale (BIRTH_MS, with a slight overshoot); 1 once grown
function lookOf(n, now) {
  const s = n.s, key = lookKey(s);
  const size = n.fin ? FIN_R : I.lens === 'cost' && !s.pending && s.state !== 'DONE' ? costRadius(s) : sessionRadius(s, 1);
  const frac = s.context && s.context.limit ? clamp(s.context.used / s.context.limit, 0, 1) : 0;
  let L = I.look.get(n.id);
  if (!L) {
    L = { key, prev: null, at: -Infinity, rb: size, busy: key === 'BUSY' ? 1 : 0, live: s.state === 'DONE' ? 0 : 1,
      g: gaugeOn(s) ? 1 : 0, frac, ringA: hashNum(n.id) * TAU, grow: 1,
      born: !I.still && !I.replay && I.lastDraw && now - I.lastDraw < 1500 ? now : -Infinity };
    I.look.set(n.id, L);
  } else if (L.key !== key) {
    // picked up: from handing off to a live look, one violet ring spreads from it (drawSession)
    if (L.key === 'HANDOFF' && key !== 'DONE' && !I.still && !I.replay) L.relay = now;
    // flipping back mid-morph reverses it from where it is, instead of starting over
    const u = (now - L.at) / MORPH_MS;
    if (L.prev === key && u < 1) { L.prev = L.key; L.at = now - (1 - u) * MORPH_MS; }
    else { L.prev = L.key; L.at = I.still ? -Infinity : now; }
    L.key = key;
  }
  L.rb = glide(L.rb, size, 420);
  L.busy = glide(L.busy, key === 'BUSY' ? 1 : 0, 650);
  L.live = glide(L.live, s.state === 'DONE' ? 0 : 1, 700);
  L.g = glide(L.g, gaugeOn(s) ? 1 : 0, 500);
  L.frac = glide(L.frac, frac, 600);
  if (!I.still) L.ringA = (L.ringA + ((TAU * (I.adt ?? 16)) / RING_TURN_MS) * L.busy) % TAU;
  const u = (now - L.born) / BIRTH_MS;
  L.grow = u >= 0 && u < 1 ? backOut(u) : 1;
  // a birth, a morph or a relay ring under way: full rate
  if (L.grow !== 1 || (L.prev && now - L.at < MORPH_MS) || (L.relay && now - L.relay < RELAY_MS)) I.quick = true;
  if (L.busy > 0.02 || key === 'HANDOFF') I.lively = true; // its ring of dots (or handing-off dashes) turns
  return L;
}

// one look, at (x, y) with radius R
function drawLook(ctx, key, s, x, y, R, ks) {
  if (key.startsWith('L:')) { orb(ctx, x, y, R, lensColor(key.slice(2), s)); return; }
  switch (key) {
    case 'NEW': {
      // a new session, no message yet: hollow, with a steady dashed ring in its account's colour
      const c = accColor(s.account);
      ctx.fillStyle = HOLE; circle(ctx, x, y, R); ctx.fill();
      ctx.fillStyle = rgba(c, 0.12); ctx.fill();
      ctx.strokeStyle = c; ctx.lineWidth = 1.8 * ks; ctx.setLineDash(DASH_NEW); ctx.lineDashOffset = 0;
      circle(ctx, x, y, R - ks); ctx.stroke(); ctx.setLineDash(DASH_NONE);
      break;
    }
    case 'HANDOFF': {
      // handing off to a fresh conversation: hollow, a violet dashed ring that turns slowly (in transit)
      ctx.fillStyle = HOLE; circle(ctx, x, y, R); ctx.fill();
      ctx.fillStyle = rgba(COL.violet, 0.14); ctx.fill();
      ctx.strokeStyle = COL.violet; ctx.lineWidth = 1.8 * ks; ctx.setLineDash(DASH_HO); ctx.lineDashOffset = -(I.time || 0) * 0.012;
      circle(ctx, x, y, R - ks); ctx.stroke(); ctx.setLineDash(DASH_NONE); ctx.lineDashOffset = 0;
      break;
    }
    case 'BUSY':
      orb(ctx, x, y, R, s.hue || COL.cyan);
      break;
    case 'ASKING':
      ctx.fillStyle = HOLE; circle(ctx, x, y, R); ctx.fill();
      ctx.fillStyle = rgba(COL.gold, 0.14); ctx.fill();
      ctx.strokeStyle = COL.gold; ctx.lineWidth = 2 * ks;
      circle(ctx, x, y, R - ks); ctx.stroke();
      orb(ctx, x, y, Math.max(1.5, R - 4.6 * ks), COL.gold);
      break;
    case 'QUESTION':
      // its reply ends on a question (nothing is blocked): ASKING's look with the ring left open at the top
      ctx.fillStyle = HOLE; circle(ctx, x, y, R); ctx.fill();
      ctx.fillStyle = rgba(COL.gold, 0.14); ctx.fill();
      ctx.strokeStyle = COL.gold; ctx.lineWidth = 2 * ks; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(x, y, Math.max(0.5, R - ks), -Math.PI / 2 + Q_GAP, Math.PI * 1.5 - Q_GAP); ctx.stroke();
      ctx.lineCap = 'butt';
      orb(ctx, x, y, Math.max(1.5, R - 4.6 * ks), COL.gold);
      break;
    case 'STALLED':
      ctx.fillStyle = HOLE; circle(ctx, x, y, R); ctx.fill();
      // a ring of dots: broken, at 60% gold
      if (!I.dashStall || I.dashStall[1] !== 4.2 * ks) I.dashStall = [0.1, 4.2 * ks];
      ctx.strokeStyle = rgba(COL.gold, 0.6); ctx.lineWidth = 2.2 * ks; ctx.setLineDash(I.dashStall);
      circle(ctx, x, y, R - ks); ctx.stroke(); ctx.setLineDash(DASH_NONE);
      break;
    case 'ERROR':
      ctx.fillStyle = HOLE; circle(ctx, x, y, R); ctx.fill();
      ctx.fillStyle = rgba(COL.red, 0.14); ctx.fill();
      ctx.strokeStyle = COL.red; ctx.lineWidth = 2 * ks;
      circle(ctx, x, y, R - ks); ctx.stroke();
      ctx.lineWidth = 1.8 * ks; cross(ctx, x, y, R * 0.38);
      break;
    default: { // DONE and anything unknown: smaller and quieter, in a muted version of its own colour, with a faint rim
      const h = /^#[0-9a-f]{6}$/i.test(s.hue || '') ? s.hue : COL.dim;
      orb(ctx, x, y, R, mixHex(h, COL.faint, 0.4));
      ctx.strokeStyle = rgba(h, 0.45); ctx.lineWidth = 1.2 * ks;
      circle(ctx, x, y, R + 1.8 * ks); ctx.stroke();
    }
  }
}

function drawSession(ctx, n, ks, selected, hovered) {
  const s = n.s, bs = n.bs || 1, R = n.R * bs, x = n.sx, y = n.sy;
  n.da = ctx.globalAlpha;
  const L = I.look.get(n.id), key = L ? L.key : lookKey(s);
  const ring = 2.5 * ks;
  // a change of state: the new look settles in over the old one, which fades out under it
  const u = L && L.prev ? clamp(((I.nowP || performance.now()) - L.at) / MORPH_MS, 0, 1) : 1;
  if (u < 1) {
    const ga = ctx.globalAlpha, m = ease(u);
    ctx.globalAlpha = ga * (1 - m * m); drawLook(ctx, L.prev, s, x, y, R * (1 - 0.1 * m), ks);
    ctx.globalAlpha = ga * m; drawLook(ctx, key, s, x, y, R * (0.9 + 0.1 * m), ks);
    ctx.globalAlpha = ga;
  } else {
    if (L) L.prev = null;
    drawLook(ctx, key, s, x, y, R, ks);
  }
  // picked up a moment ago: one violet ring spreads from it and fades
  const ru = L && L.relay ? ((I.nowP || performance.now()) - L.relay) / RELAY_MS : 1;
  if (ru >= 0 && ru < 1) {
    const ga = ctx.globalAlpha, m = ease(ru);
    ctx.globalAlpha = ga * 0.6 * (1 - m);
    ctx.strokeStyle = COL.violet; ctx.lineWidth = 2 * ks;
    circle(ctx, x, y, (n.RG || n.R) * bs + (3 + 16 * m) * ks); ctx.stroke();
    ctx.globalAlpha = ga;
  } else if (L && L.relay) L.relay = 0;
  // memory gauge: context used, clockwise from 12 o'clock over a faint full track; it thins away when done
  const g = L ? L.g : gaugeOn(s) ? 1 : 0;
  if (g > 0.02 && s.context && s.context.limit) {
    const RG = Math.max(0, n.RG * bs);
    ctx.strokeStyle = rgba(COL.dim, 0.14); ctx.lineWidth = ring * g;
    circle(ctx, x, y, RG); ctx.stroke();
    const frac = L ? L.frac : clamp(s.context.used / s.context.limit, 0, 1);
    if (frac > 0) {
      ctx.strokeStyle = ctxColor(ctxPct(s));
      ctx.beginPath(); ctx.arc(x, y, Math.max(0.5, RG), -Math.PI / 2, -Math.PI / 2 + Math.max(0.02, frac) * Math.PI * 2); ctx.stroke(); // (0 at birth)
    }
    // where the handoff limit sits on the gauge: a small tick across it
    const hf = Number(s.context.handoff) / s.context.limit;
    if (hf > 0.005 && hf < 0.995) {
      const a = -Math.PI / 2 + hf * TAU, ca = Math.cos(a), sa = Math.sin(a), r0 = RG - ring * g * 0.9, r1 = RG + ring * g * 0.9 + 1.2 * ks;
      ctx.strokeStyle = rgba(COL.text, 0.8); ctx.lineWidth = 1.3;
      line(ctx, x + ca * r0, y + sa * r0, x + ca * r1, y + sa * r1);
    }
  }
  // in the multi-selection: a steady double ring
  if (n.sid && I.multi.has(n.sid)) {
    ctx.strokeStyle = COL.cyan; ctx.lineWidth = 1.2;
    circle(ctx, x, y, n.RG + 4.5 * ks); ctx.stroke();
    circle(ctx, x, y, n.RG + 7.7 * ks); ctx.stroke();
  }
  if (selected) { ctx.strokeStyle = COL.cyan; ctx.lineWidth = 1.6; circle(ctx, x, y, n.RG + 4.5 * ks); ctx.stroke(); }
  else if (hovered) { ctx.strokeStyle = rgba(COL.dim, 0.7); ctx.lineWidth = 1; circle(ctx, x, y, n.RG + 4.5 * ks); ctx.stroke(); }
}

// ---------- labels with collision avoidance ----------
// Labels sit on small frosted pills. A line is a list of segments: { t, f, c } text, or { acc, c } an
// account tag drawn as a tiny coloured circle with its letter.
const PILL_X = 7, PILL_Y = 2.5, ACC_D = 13, ACC_GAP = 5, HERE_W = 13;
const segW = (ctx, sg) => (sg.acc !== undefined ? (ACC_GAP + ACC_D) * (I.sf || 1) : sg.here ? (ACC_GAP + HERE_W) * (I.sf || 1) : measure(ctx, sg.f, sg.t));
// "here": the conversation runs live in Fleet View's own window. A small terminal glyph after the account.
function drawHere(ctx, x, y, c) {
  const w = HERE_W, h = 10, x0 = x + 0.5, y0 = Math.round(y - h / 2) - 0.5;
  ctx.strokeStyle = c; ctx.lineWidth = 1.2;
  roundRect(ctx, x0, y0, w - 1, h, 2.5); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x0 + 3, y0 + 3); ctx.lineTo(x0 + 5.5, y0 + 5); ctx.lineTo(x0 + 3, y0 + 7);
  ctx.moveTo(x0 + 7, y0 + 7.2); ctx.lineTo(x0 + 9.5, y0 + 7.2); ctx.stroke();
}
function drawLabels(ctx, k, ks, clashLabels, selNode, hovNode, fileAlpha) {
  const W = I.W, H = I.H;
  const placed = [];
  const obstacles = [];
  for (const n of I.nodes) {
    if (n.kind !== 'recent' && n.sx !== undefined) {
      const r = (n.RO || n.RG || n.R) + (n.kind === 'session' || n.kind === 'repo' ? 2 : 1);
      obstacles.push({ id: n.id, sid: n.kind === 'agent' || n.kind === 'pr' ? n.sid : null, x: n.sx - r, y: n.sy - r, w: 2 * r, h: 2 * r });
    }
  }
  for (const gh of I.parGhosts) { const r = gh.r + 1; obstacles.push({ id: 'g:' + gh.n.sid, sid: null, x: gh.x - r, y: gh.y - r, w: 2 * r, h: 2 * r }); }
  // the bots' mascots (map-bots.js, overlayApi botSpots): no label sits on one
  const bots = I.replay ? [] : I.botSpots || [];
  for (const b of bots) { const r = b.r + 1; obstacles.push({ id: 'B:' + b.id, sid: null, x: b.x - r, y: b.y - r, w: 2 * r, h: 2 * r }); }
  // ownSid: a conversation's own agents and PR don't block its name (second try, when nothing else fits)
  const hit = (r, owner, ignoreObs, ownSid) => {
    if (r.x < 2 || r.y < 2 || r.x + r.w > W - 2 || r.y + r.h > H - 2) return true;
    for (const p of placed) if (r.x < p.x + p.w + 3 && r.x + r.w + 3 > p.x && r.y < p.y + p.h + 1 && r.y + r.h + 1 > p.y) return true;
    if (!ignoreObs) for (const o of obstacles) if (o.id !== owner && (!ownSid || o.sid !== ownSid) && r.x < o.x + o.w && r.x + r.w > o.x && r.y < o.y + o.h && r.y + r.h > o.y) return true;
    return false;
  };
  const jobs = [];
  const focusSid = (hovNode && hovNode.sid) || (selNode && selNode.sid) || null;
  const noSel = !selNode;

  for (const n of I.nodes) {
    if (n.kind === 'session') {
      const s = n.s, must = n === selNode || n === hovNode;
      const f = n.fin && !must ? font(11, 500) : font(12, 600);
      const maxW = must ? 260 : k < 0.55 ? 150 : 200;
      const lines = wrap(I.ctx, f, s.name || s.id, maxW).map((t) => [{ t, f, c: s.state === 'DONE' ? COL.dim : COL.text }]);
      lines[lines.length - 1].push({ acc: s.account || '?', c: accColor(s.account) });
      if (I.ui && typeof I.ui.isHosted === 'function' && I.ui.isHosted(s.id)) lines[lines.length - 1].push({ here: true, c: COL.cyan });
      const pct = ctxPct(s);
      // in a lens, its value (cost, idle time, context) sits under the orb instead of the context %
      const lt = I.lens !== 'state' && s.state !== 'DONE' && !s.pending ? lensText(I.lens, s) : null;
      const showPct = !lt && pct !== null && s.state !== 'DONE' && (k >= 1.25 || must);
      let below = n.RG + 5 * ks;
      if (showPct || lt) {
        const pf = font(10, 600, MONO), t = lt || pct + '%', c = lt ? lensColor(I.lens, s) : ctxColor(pct);
        jobs.push({ prio: (must ? 2000 : 900) + 1, must, owner: n.id, lines: [[{ t, f: pf, c }]], lh: 11, pill: true, anchors: [(w, h) => [n.sx - w / 2, n.sy + n.RG + 2 * ks]] });
        below += 17 * (I.sf || 1);
      }
      const prio = must ? 2000 : NEEDS_YOU.has(s.state) ? 950 : s.state === 'DONE' ? 300 : 800 + Math.min(50, s.calls20 || 0);
      const off = n.RG + 6 * ks;
      // just outside the ring of agents, for a conversation whose agents fill every spot next to it
      const ring = n.agents.length ? Math.max(32 * k, n.RG + 10 * ks) + (n.agents.length > 10 ? 4 * ks : 0) + 3.6 * ks + 4 : off;
      jobs.push({
        prio, must, owner: n.id, sid: s.id, lines, lh: 15, pill: true,
        anchors: [
          (w, h) => [n.sx - w / 2, n.sy + below],
          (w, h) => [n.sx - w / 2, n.sy - off - h],
          (w, h) => [n.sx + off + 2, n.sy - h / 2],
          (w, h) => [n.sx - off - 2 - w, n.sy - h / 2],
          (w, h) => [n.sx + off * 0.7, n.sy + off * 0.7],
          (w, h) => [n.sx - off * 0.7 - w, n.sy + off * 0.7],
          (w, h) => [n.sx + off * 0.7, n.sy - off * 0.7 - h],
          (w, h) => [n.sx - off * 0.7 - w, n.sy - off * 0.7 - h],
          (w, h) => [n.sx - w / 2, n.sy + below + 14],
          (w, h) => [n.sx - w / 2, n.sy + Math.max(below, ring)],
          (w, h) => [n.sx - w / 2, n.sy - ring - h],
          (w, h) => [n.sx + ring + 2, n.sy - h / 2],
          (w, h) => [n.sx - ring - 2 - w, n.sy - h / 2],
        ],
      });
    } else if (n.kind === 'repo') {
      // the repo's name right next to its hub (below, above, beside, then a little farther out), on a pill
      // in the repo's colour; placed before the conversations' names so it keeps its spot by the hub
      const f = font(13, 700, DISPLAY);
      const must = n === selNode || n === hovNode;
      const g = (n.RO || n.RG) + 3, d = g * 0.72;
      jobs.push({
        prio: must ? 1900 : 1000, must, owner: n.id, lines: [[{ t: n.name, f, c: n.color }]], lh: 17, pill: true,
        anchors: [
          (w, h) => [n.sx - w / 2, n.sy + g], (w, h) => [n.sx - w / 2, n.sy - g - h],
          (w, h) => [n.sx + g, n.sy - h / 2], (w, h) => [n.sx - g - w, n.sy - h / 2],
          (w, h) => [n.sx + d, n.sy + d], (w, h) => [n.sx - d - w, n.sy + d],
          (w, h) => [n.sx + d, n.sy - d - h], (w, h) => [n.sx - d - w, n.sy - d - h],
          (w, h) => [n.sx - w / 2, n.sy + g + 12], (w, h) => [n.sx - w / 2, n.sy - g - 12 - h],
        ],
      });
    } else if (n.kind === 'pr') {
      const must = n === selNode || n === hovNode;
      if (!must && k < 0.45) continue;
      const f = font(10, 600, MONO);
      jobs.push({
        prio: must ? 1800 : 420, must, owner: n.id, lines: [[{ t: '#' + n.num, f, c: shipColor(n.ship) }]], lh: 12, pill: true,
        anchors: [(w, h) => [n.sx + n.R + 4, n.sy - h / 2], (w, h) => [n.sx - n.R - 4 - w, n.sy - h / 2], (w, h) => [n.sx - w / 2, n.sy + n.R + 3], (w, h) => [n.sx - w / 2, n.sy - n.R - 3 - h]],
      });
    } else if (n.kind === 'agent') {
      const must = n === selNode || n === hovNode;
      const show = must || focusSid === n.sid || (noSel && k >= 0.7);
      if (!show) continue;
      const f = font(10.5, 500);
      const c = n.a.state === 'fail' ? COL.red : n.a.state === 'run' ? n.s.hue : COL.dim;
      const ux = Math.cos(n.ang), uy = Math.sin(n.ang);
      const g = n.R + 4;
      jobs.push({
        prio: must ? 1700 : focusSid === n.sid ? 600 : 200, must, owner: n.id, lines: [[{ t: n.a.label, f, c }]], lh: 12, pill: true,
        anchors: [
          (w, h) => [n.sx + ux * g + (ux >= 0 ? 0 : -w), n.sy + uy * g - h / 2 + (Math.abs(uy) > 0.85 ? uy * h / 2 : 0)],
          (w, h) => [n.sx + g, n.sy - h / 2],
          (w, h) => [n.sx - g - w, n.sy - h / 2],
        ],
      });
    } else if (n.kind === 'recent' && n === hovNode) {
      const f = font(10, 500, MONO);
      jobs.push({ prio: 1600, must: true, owner: n.id, lines: [[{ t: lastParts(n.f.rel), f, c: COL.text }]], lh: 12, pill: true, anchors: [(w, h) => [n.sx + 6, n.sy - h / 2], (w, h) => [n.sx - 6 - w, n.sy - h / 2]] });
    } else if (n.kind === 'clash' && n === hovNode) {
      const f = font(10, 600, MONO);
      jobs.push({ prio: 1600, must: true, owner: n.id, lines: [[{ t: lastParts(n.c.rel), f, c: n.c.writers >= 2 ? COL.red : COL.gold }]], lh: 12, pill: true, anchors: [(w, h) => [n.sx + 7, n.sy - h / 2], (w, h) => [n.sx - 7 - w, n.sy - h / 2]] });
    } else if (n.kind === 'conflict' && n.k.kind !== 'migration') {
      // the branch's or the worktree's name beside its node (a migration's tag is its own label)
      const must = n === selNode || n === hovNode, f = font(10, 600, MONO), g = (n.RG || n.R) + 4;
      jobs.push({ prio: must ? 1600 : 640, must, owner: n.id, lines: [[{ t: String(n.k.label || ''), f, c: conflictColor(n.k) }]], lh: 12, pill: true,
        anchors: [(w, h) => [n.sx + g, n.sy - h / 2], (w, h) => [n.sx - g - w, n.sy - h / 2], (w, h) => [n.sx - w / 2, n.sy + g], (w, h) => [n.sx - w / 2, n.sy - g - h]] });
    }
  }
  // a bot's name, as a workspace's: its own colour on the frosted pill, under its mascot (else above, beside, a little
  // farther out), and "· 2" when it watches two conversations; picked, hovered or held, it shows over anything
  for (const b of bots) {
    const f = font(13, 700, DISPLAY), g = b.r + 3, d = g * 0.72;
    const segs = [{ t: b.name, f, c: b.live ? b.color : rgba(b.color, 0.7) }];
    if (b.watching) segs.push({ t: ` · ${b.watching}`, f: font(11.5, 600), c: COL.dim });
    jobs.push({
      prio: b.must ? 1900 : 990, must: !!b.must, owner: 'B:' + b.id, lines: [segs], lh: 17, pill: true,
      anchors: [
        (w, h) => [b.x - w / 2, b.y + g], (w, h) => [b.x - w / 2, b.y - g - h],
        (w, h) => [b.x + g, b.y - h / 2], (w, h) => [b.x - g - w, b.y - h / 2],
        (w, h) => [b.x + d, b.y + d], (w, h) => [b.x - d - w, b.y + d],
        (w, h) => [b.x - w / 2, b.y + g + 12], (w, h) => [b.x - w / 2, b.y - g - 12 - h],
      ],
    });
  }
  // team pills: the team's name at its link's middle
  for (const tm of I.teams) {
    if (!tm.pill) continue;
    const p = tm.pill, hov = I.hoverX && I.hoverX.kind === 'team' && I.hoverX.id === tm.t.id;
    // "★ lead · team" for a team with a lead (the lead's name cut short unless hovered)
    const ln = tm.lead ? String(nameOf(tm.lead) || '') : '', lns = !hov && ln.length > 22 ? ln.slice(0, 21) + '…' : ln;
    const segs = tm.lead ? [{ t: `★ ${lns}`, f: font(10.5, 600), c: p.color }, { t: ' · ', f: font(10.5, 400), c: COL.dim }, { t: tm.t.name || 'team', f: font(10.5, 600), c: p.color }]
      : [{ t: tm.t.name || 'team', f: font(10.5, 600), c: p.color }];
    jobs.push({ prio: hov ? 1650 : 860, must: hov, owner: 'T:' + tm.t.id, lines: [segs], lh: 13, pill: true,
      // on the link's middle, else beside it, a little farther out each time
      anchors: [[0, 0], [0, -1], [0, 1], [1, 0], [-1, 0], [0, -2], [0, 2], [1.4, -1], [-1.4, 1], [1.4, 1], [-1.4, -1], [0, -3], [0, 3]]
        .map(([ax, ay]) => (w, h) => [p.x - w / 2 + ax * (w / 2 + 8), p.y - h / 2 + ay * (h + 4)]) });
  }
  // a hovered parity line says what it is
  if (I.hoverX && I.hoverX.kind === 'parity' && I.hoverX.l) {
    const m = I.hoverX.l.mid, f = font(10, 600);
    jobs.push({ prio: 1650, must: true, owner: 'P:' + I.hoverX.id, lines: [[{ t: 'web', f, c: COL.cyan }, { t: ' ↔ ', f, c: COL.dim }, { t: 'app', f, c: COL.mint }]], lh: 12, pill: true,
      anchors: [(w, h) => [m[0] - w / 2, m[1] - h - 5], (w, h) => [m[0] - w / 2, m[1] + 5]] });
  }
  // one-sided changes: "no app change" beside the ghost orb
  for (const gh of I.parGhosts) {
    const f = font(10, 500), g = gh.r + 4, g2 = g + 10, hov = I.hoverX && I.hoverX.kind === 'ghost' && I.hoverX.id === 'g:' + gh.n.sid;
    jobs.push({ prio: hov ? 1600 : 520, must: hov, owner: 'g:' + gh.n.sid, lines: [[{ t: gh.missing === 'web' ? 'no web change' : 'no app change', f, c: gh.col }]], lh: 12, pill: true,
      anchors: [(w, h) => [gh.x + g, gh.y - h / 2], (w, h) => [gh.x - g - w, gh.y - h / 2], (w, h) => [gh.x - w / 2, gh.y - g - h], (w, h) => [gh.x - w / 2, gh.y + g],
        (w, h) => [gh.x + g2, gh.y - h / 2], (w, h) => [gh.x - g2 - w, gh.y - h / 2], (w, h) => [gh.x - w / 2, gh.y - g2 - h], (w, h) => [gh.x - w / 2, gh.y + g2]] });
  }
  for (const cl of clashLabels) {
    const f = font(10, 600, MONO);
    jobs.push({
      prio: cl.c.writers >= 2 ? 700 : 650, must: false, owner: null, key: 'cl:' + cl.c.key,
      lines: [[{ t: (cl.c.writers >= 2 ? '⚠ ' : '') + lastParts(cl.c.rel), f, c: cl.color }]], lh: 12, pill: true,
      // one label per shared file, at the midpoint of the first of its lines where it fits
      // when the midpoint is taken, slide along the line a little either way
      anchors: [0.5, 0.4, 0.6, 0.3, 0.7].flatMap((t) => cl.mids.map((m) => {
        const u = 1 - t, x = u * u * m.ax + 2 * u * t * m.cx + t * t * m.bx, y = u * u * m.ay + 2 * u * t * m.cy + t * t * m.by;
        return (w, h) => [x - w / 2, y - h / 2];
      })),
    });
  }

  jobs.sort((a, b) => b.prio - a.prio);
  if (I.labelRects) I.labelRects.clear();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  for (const j of jobs) {
    const widths = j.lines.map((ln) => ln.reduce((w, sg) => w + segW(ctx, sg), 0));
    const sf = I.sf || 1, lh = j.lh * sf, px = j.pill ? PILL_X * sf : 0, py = j.pill ? PILL_Y * sf : 0;
    const w = Math.ceil(Math.max(...widths)) + 2 * px, h = j.lines.length * lh + 2 * py;
    // nodes drift every frame, so a label keeps the anchor it had while that one still fits; without
    // this a label near a neighbour would hop between spots as the two sway
    const key = j.key || j.owner + '|' + j.lh;
    const prev = I.lab.get(key);
    const tryAll = (ignoreObs, ownSid) => {
      for (let i = prev === undefined ? 0 : -1; i < j.anchors.length; i++) {
        const idx = i < 0 ? prev : i;
        if (i >= 0 && idx === prev) continue;
        const an = j.anchors[idx];
        if (!an) continue;
        const [x, y] = an(w, h);
        const r = { x, y, w, h };
        if (!hit(r, j.owner, ignoreObs, ownSid)) { I.lab.set(key, idx); return r; }
      }
      return null;
    };
    // labels never sit on an orb if any spot is free: a hovered or selected one goes over orbs only as a last
    // resort, and an optional pill (a team's, a parity ghost's "no web change") is left out rather than cover one
    let rect = tryAll(false);
    if (!rect && j.sid) rect = tryAll(false, j.sid);
    if (!rect && j.must) rect = tryAll(true);
    if (!rect && j.must) {
      const [x, y] = j.anchors[0](w, h);
      rect = { x: clamp(x, 2, W - w - 2), y: clamp(y, 2, H - h - 2), w, h };
    }
    if (!rect) continue;
    placed.push(rect);
    if (j.owner) (I.labelRects || (I.labelRects = new Map())).set(j.owner + '|' + j.lh, rect);
    if (j.owner && j.owner.startsWith('T:')) { const tm = I.teams.find((x) => 'T:' + x.t.id === j.owner); if (tm) tm.rect = rect; }
    if (j.pill) {
      const rr = j.lines.length > 1 ? 8 * sf : h / 2;
      ctx.fillStyle = PILL_BG;
      roundRect(ctx, rect.x, rect.y, rect.w, rect.h, rr); ctx.fill();
      ctx.strokeStyle = PILL_EDGE; ctx.lineWidth = 1;
      roundRect(ctx, rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1, rr - 0.5); ctx.stroke();
    }
    j.lines.forEach((ln, i) => {
      const lw = widths[i];
      let x = rect.x + (rect.w - lw) / 2;
      const y = rect.y + py + i * lh + lh / 2 + 0.5;
      for (const sg of ln) {
        if (sg.acc !== undefined) {
          const cx = x + (ACC_GAP + ACC_D / 2) * sf, r = ACC_D / 2 * sf;
          ctx.fillStyle = rgba(sg.c, 0.2); circle(ctx, cx, y - 0.5, r); ctx.fill();
          ctx.strokeStyle = rgba(sg.c, 0.55); ctx.lineWidth = 1; circle(ctx, cx, y - 0.5, r - 0.5); ctx.stroke();
          ctx.font = ACC_FONT(); ctx.fillStyle = sg.c; ctx.textAlign = 'center';
          ctx.fillText(sg.acc, cx, y);
          ctx.textAlign = 'left';
          x += (ACC_GAP + ACC_D) * sf;
          continue;
        }
        if (sg.here) {
          ctx.save(); ctx.translate(x + ACC_GAP * sf, y - 0.5); ctx.scale(sf, sf); drawHere(ctx, 0, 0, sg.c); ctx.restore();
          x += (ACC_GAP + HERE_W) * sf; continue;
        }
        ctx.font = sg.f;
        // a label without a pill (a repo's name) gets a soft dark edge, so it reads over any backdrop
        if (!j.pill) { ctx.strokeStyle = LABEL_HALO; ctx.lineWidth = 3; ctx.strokeText(sg.t, x, y); }
        ctx.fillStyle = sg.c; ctx.fillText(sg.t, x, y);
        x += measure(ctx, sg.f, sg.t);
      }
    });
  }
}
function roundRect(ctx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r); ctx.closePath();
}

// ---------- hit testing and input ----------
function hitTest(sx, sy) {
  let best = null, bd = Infinity;
  const rank = { session: 0, repo: 1, agent: 2, pr: 2, clash: 2, conflict: 2, recent: 3 };
  for (const n of I.nodes) {
    if (n.sx === undefined) continue;
    const d = Math.hypot(n.sx - sx, n.sy - sy);
    const reach = (n.RG || n.R || 4) + (n.kind === 'recent' ? 7 : 6);
    if (d > reach) continue;
    const score = d + rank[n.kind] * 6;
    if (score < bd) { bd = score; best = n; }
  }
  return best;
}

// what's under the mouse that isn't a node. A team's pill (drawn over everything) and worktree satellites (tiny,
// on a hub's outer ring) come before the nodes (hitOver); the rest only where no node is: a parity ghost, then
// the nearest link (team, parity, handoff) within 5 px. Returns { kind, id, ... } or null.
function hitOver(sx, sy) {
  for (const tm of I.teams) {
    const r = tm.rect;
    if (r && sx >= r.x && sx <= r.x + r.w && sy >= r.y && sy <= r.y + r.h) return { kind: 'team', id: tm.t.id };
  }
  for (const w of I.wtHits) if (Math.hypot(w.x - sx, w.y - sy) <= w.r + 3) return { kind: 'worktree', id: w.w.path, w: w.w, hub: w.hub };
  return null;
}
function hitExtra(sx, sy) {
  for (const g of I.parGhosts) if (Math.hypot(g.x - sx, g.y - sy) <= g.r + 4) return { kind: 'ghost', id: 'g:' + g.n.sid, g };
  let best = null, bd = 5;
  for (const l of I.linkHits) { const d = distPts(l.pts, sx, sy); if (d < bd) { bd = d; best = l; } }
  return best ? { kind: best.kind, id: best.id, l: best } : null;
}
// the shell's menu targets for a conflict node and a shared-file (clash) node
function conflictTarget(k) {
  const f = Array.isArray(k.files) && k.files[0];
  return { kind: 'conflict', id: k.id, kind2: k.kind, label: k.label, sessions: k.sessions.slice(), root: k.root || null,
    rel: f ? f.rel : undefined, abs: f ? f.abs : undefined, files: Array.isArray(k.files) ? k.files.slice() : undefined };
}
function clashTarget(c) {
  return { kind: 'conflict', id: c.id, kind2: 'clash', label: lastParts(c.rel), sessions: c.sessions.map((x) => x.id), root: c.root || null,
    rel: c.rel, abs: fileAbs(c.key, null) || undefined, writers: c.writers };
}

function select(n, fromKeys) {
  I.sel = n ? n.id : null;
  I.kbTip = !!fromKeys;
  I.dirty = true;
  // arrow keys only show the panel; a click on a conversation also starts its live session (desktop window)
  try { I.ui.setSelected && I.ui.setSelected(n ? n.sid || null : null, fromKeys ? 'keys' : 'click'); } catch { /* shell gone */ }
  if (fromKeys && n) ensureVisible(n);
}

function syncSelection() {
  const want = I.ui && I.ui.selectedId;
  const cur = I.sel ? I.byId.get(I.sel) : null;
  if (want) {
    if (!cur || cur.sid !== want) I.sel = I.byId.has('s:' + want) ? 's:' + want : I.sel;
  } else if (cur && cur.sid && I.ui && 'selectedId' in I.ui) I.sel = null;
}

function ensureVisible(n) {
  const m = 60;
  let dx = 0, dy = 0;
  if (n.sx < m) dx = n.sx - m; else if (n.sx > I.W - m) dx = n.sx - (I.W - m);
  if (n.sy < m) dy = n.sy - m; else if (n.sy > I.H - m) dy = n.sy - (I.H - m);
  if (dx || dy) { I.pan.x += dx / K(); I.pan.y += dy / K(); I.dirty = true; }
}

function wireMouse(cv) {
  cv.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
  }, { passive: false });
  cv.addEventListener('mousedown', (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    e.preventDefault();
    // a left-drag on a repo's hub moves the repo (and pins it), on a conversation moves that conversation
    // (and pins it); anywhere else it pans
    // Ctrl (or Shift) on a node: a click toggles it in the multi-selection, a drag pans; Ctrl on empty space
    // draws the rubber band, which takes conversations and workspaces (repo hubs). A drag on a hub that is in the
    // multi-selection moves every selected hub with it.
    const r = cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
    const hit = e.button === 0 ? hitTest(sx, sy) : null;
    const mod = e.ctrlKey || e.metaKey;
    if (e.button === 0 && mod && !e.shiftKey && !hit) {
      I.glide = null;
      I.drag = { x: e.clientX, y: e.clientY, moved: false, button: 0, node: null,
        band: { x0: sx, y0: sy, x1: sx, y1: sy, base: new Set(I.multi), baseRepos: new Set(I.multiRepos) } };
      return;
    }
    const node = !mod && !e.shiftKey && hit && (hit.kind === 'repo' || hit.kind === 'session') ? hit.id : null;
    // the hubs it moves, by id (a /state can rebuild the nodes mid-drag). A selected hub, or a selected
    // conversation while workspaces are selected too, moves the whole selection: every selected hub, and the
    // selected conversations of other repos with it (convs)
    const picked = I.multi.size ? I.multi : I.sel && I.byId.get(I.sel) && I.byId.get(I.sel).kind === 'session' ? new Set([I.byId.get(I.sel).sid]) : new Set();
    const group = node && I.multiRepos.size && (hit.kind === 'repo' ? I.multiRepos.has(node) : picked.has(hit.sid));
    let hubs = node && hit.kind === 'repo' ? [node] : null, convs = null;
    if (group) {
      hubs = [...I.multiRepos].filter((id) => I.byId.has(id));
      convs = I.sim.filter((m) => m.kind === 'session' && m.p && picked.has(m.sid) && !hubs.includes(m.cl) && convBase(m)).map((m) => m.id);
    }
    I.drag = { x: e.clientX, y: e.clientY, moved: false, button: e.button, mod, shift: e.shiftKey, node, hubs, convs, group: !!group };
  });
  window.addEventListener('mousemove', (e) => {
    if (!I || I.canvas !== cv) return;
    if (I.drag) {
      const dx = e.clientX - I.drag.x, dy = e.clientY - I.drag.y;
      if (!I.drag.moved && Math.hypot(dx, dy) > 4) I.drag.moved = true;
      if (I.drag.band && I.drag.moved) {
        // the band: everything inside it joins the selection it started from
        const b = I.drag.band, r = cv.getBoundingClientRect();
        b.x1 = e.clientX - r.left; b.y1 = e.clientY - r.top;
        const x0 = Math.min(b.x0, b.x1), x1 = Math.max(b.x0, b.x1), y0 = Math.min(b.y0, b.y1), y1 = Math.max(b.y0, b.y1);
        const set = new Set(b.base), repos = new Set(b.baseRepos);
        for (const n of I.nodes) {
          if (!onScreen(n) || n.sx < x0 || n.sx > x1 || n.sy < y0 || n.sy > y1) continue;
          if (n.kind === 'session') set.add(n.sid);
          else if (n.kind === 'repo') repos.add(n.id);
        }
        I.multi = set; I.multiRepos = repos; I.band = b; I.dirty = true;
        hideTip();
        return;
      }
      if (I.drag.moved && !I.drag.band) {
        const hub = I.drag.node && I.byId.get(I.drag.node);
        const base = !I.drag.group && hub && hub.kind === 'session' && hub.p && convBase(hub);
        if (base) {
          // one conversation: it follows the mouse, kept as an offset from its repo's hub
          hub.p.x += dx / K(); hub.p.y += dy / K(); hub.p.vx = hub.p.vy = 0;
          I.homeXY.set(hub.id, { x: hub.p.x - base.x, y: hub.p.y - base.y, pin: true });
          // its PR and recent files come along most of the way (only the ones tied to it alone), so they
          // trail a little behind instead of being hauled by the weak springs; the springs settle the rest
          if (!I.drag.dots) {
            const ties = new Map();
            for (const s of I.springs) for (const id of [s.a, s.b]) ties.set(id, (ties.get(id) || 0) + 1);
            I.drag.dots = [];
            for (const s of I.springs) {
              const o = s.a === hub.id ? s.b : s.b === hub.id ? s.a : null;
              const m = o && ties.get(o) === 1 && I.byId.get(o);
              if (m && m.p && (m.kind === 'pr' || m.kind === 'recent')) I.drag.dots.push(m);
            }
          }
          for (const m of I.drag.dots) { m.p.x += 0.8 * dx / K(); m.p.y += 0.8 * dy / K(); }
          I.alpha = Math.max(I.alpha, 0.05);
          const to = dropRepo(hub);
          I.drag.drop = to ? to.id : null;
        } else if (I.drag.group || (hub && hub.kind === 'repo' && hub.p)) {
          // the hub (and the other selected hubs with it) follows the mouse and everything on it trails behind,
          // easing back into the same shape (trailStep); its spot follows and is pinned. The selected
          // conversations of other repos move along, each kept as an offset from its own repo's hub.
          const wx = dx / K(), wy = dy / K();
          for (const id of I.drag.convs || []) {
            const m = I.byId.get(id), b = m && m.p && convBase(m);
            if (!b) continue;
            m.p.x += wx; m.p.y += wy; m.p.vx = m.p.vy = 0;
            I.homeXY.set(m.id, { x: m.p.x - b.x, y: m.p.y - b.y, pin: true });
          }
          for (const id of I.drag.hubs || [hub.id]) {
            const h = I.byId.get(id);
            if (!h || !h.p) continue;
            startTrail(h); // before it moves: the shape to come back to is the one it has now
            h.p.x += wx; h.p.y += wy; h.p.vx = h.p.vy = 0;
            I.homeXY.set(h.id, { x: h.p.x, y: h.p.y, pin: true });
          }
          I.alpha = Math.max(I.alpha, 0.05);
        } else { I.glide = null; I.pan.x -= dx / K(); I.pan.y -= dy / K(); }
        I.drag.x = e.clientX; I.drag.y = e.clientY;
        I.dirty = true; cv.style.cursor = 'grabbing';
        hideTip();
        return;
      }
    }
    if (e.target !== cv) return;
    const r = cv.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    const wt = hitOver(sx, sy);
    const n = wt ? null : hitTest(sx, sy);
    const x = wt || (n ? null : hitExtra(sx, sy));
    const id = n ? n.id : null;
    I.mouse = { x: sx, y: sy };
    I.kbTip = false;
    if (id !== I.hover) { I.hover = id; I.dirty = true; }
    const xk = (o) => (o ? o.kind + ':' + o.id : null);
    if (xk(x) !== xk(I.hoverX)) { I.hoverX = x; I.dirty = true; } else if (x) I.hoverX = x;
    cv.style.cursor = n && n.kind === 'repo' ? 'grab' : n && (n.kind === 'session' || nodeAction(n)) ? 'pointer' : 'default';
    updateTip();
  });
  window.addEventListener('mouseup', (e) => {
    if (!I || I.canvas !== cv || !I.drag) return;
    const d = I.drag;
    I.drag = null;
    cv.style.cursor = 'default';
    if (d.band) {
      I.band = null; I.dirty = true;
      const same = I.multi.size === d.band.base.size && [...I.multi].every((id) => d.band.base.has(id));
      if (!d.moved) I.multiRepos = d.band.baseRepos;
      if (d.moved && !same) setMulti(new Set(I.multi));
      else I.multi = d.band.base;
      return;
    }
    if (d.moved && d.node) {
      const n = I.byId.get(d.node), to = d.drop && I.byId.get(d.drop);
      if (n && n.kind === 'session' && to && to.p && n.p) {
        // dropped on another repo: it moves there (the server keeps it), placed where it was let go
        I.homeXY.set(n.id, { x: n.p.x - to.p.x, y: n.p.y - to.p.y, pin: true });
        n.cl = to.id;
        // a move that didn't happen: back on its own repo's ring
        const undo = () => { if (I && I.homeXY.get(n.id)) { I.homeXY.delete(n.id); I.alpha = Math.max(I.alpha, 0.3); saveSpotsSoon(300, true); } };
        try { Promise.resolve(I.ui.moveSession(n.sid, to.root)).then((ok) => { if (!ok) undo(); }, undo); } catch (err) { console.error(err); undo(); }
      }
      saveSpotsSoon(300, true); I.dirty = true;
    }
    if (d.moved || d.button !== 0 || e.target !== cv) return;
    const r = cv.getBoundingClientRect();
    let n = hitTest(e.clientX - r.left, e.clientY - r.top);
    if (d.mod || d.shift) {
      // Ctrl+click: in or out of the multi-selection (the conversation picked so far joins it first); a hub
      // goes in or out of the selection's workspaces
      if (n && n.kind === 'repo') {
        const rs = new Set(I.multiRepos);
        if (rs.has(n.id)) rs.delete(n.id); else rs.add(n.id);
        I.multiRepos = rs; I.lastClick = null; I.dirty = true;
        return;
      }
      const sid = n && (n.kind === 'session' || n.kind === 'agent') ? n.sid : null; // new (empty) ones too
      if (!sid) return;
      const set = new Set(I.multi), cur = !set.size && I.sel ? I.byId.get(I.sel) : null;
      if (cur && cur.kind === 'session' && cur.sid && cur.sid !== sid) set.add(cur.sid);
      if (set.has(sid)) set.delete(sid); else set.add(sid);
      I.lastClick = null;
      setMulti(set);
      return;
    }
    clearMulti(); // a plain click: back to a single pick
    // the second click of a double-click belongs to the node the first one hit, even when the view moved
    // in between (a pick opens the shell's detail panel, which can narrow the map and shift every node)
    if (e.detail >= 2) n = recentClick() || n;
    else I.lastClick = n ? { id: n.id, t: performance.now() } : null;
    // a second, separate click on a picked PR or file acts on it (a conversation's second click only keeps it
    // picked: opening a terminal tab takes a double-click or Enter; a repo's selects its conversations only on a
    // double-click or Enter)
    if (n && n.id === I.sel && e.detail === 1 && n.kind !== 'session' && n.kind !== 'agent' && n.kind !== 'repo' && act(n)) return;
    if (e.detail >= 2 && n && n.id === I.sel) return; // already picked: don't re-pick (no extra redraw)
    // (a file dot only gets picked: it opens from its right-click menu, a double-click or Enter)
    select(n, false);
  });
  cv.addEventListener('mouseleave', () => { if (I.hover || I.hoverX) { I.hover = null; I.hoverX = null; I.dirty = true; } hideTip(); });
  // right-click: the shell's menu for a conversation (or an agent's conversation) or a repo
  cv.addEventListener('contextmenu', (e) => {
    if (!I || !I.ui || typeof I.ui.contextMenu !== 'function') return;
    const r = cv.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
    const over = hitOver(sx, sy);
    const n = over ? null : hitTest(sx, sy);
    let target = null;
    if (over) target = over.kind === 'team' ? { kind: 'team', id: over.id } : null;
    else if (n && (n.kind === 'session' || n.kind === 'agent') && n.sid) {
      // one of a multi-selection of 2+: the menu for all of them
      target = I.multi.size >= 2 && I.multi.has(n.sid) ? { kind: 'sessions', ids: [...I.multi] } : { kind: 'session', id: n.sid };
    }
    else if (n && n.kind === 'repo' && n.root) target = { kind: 'repo', root: n.root, name: n.name, color: n.color };
    else if (n && n.kind === 'conflict') target = conflictTarget(n.k);
    else if (n && n.kind === 'clash') target = clashTarget(n.c);
    // a file dot or a PR dot: its own menu (Open, Copy, its conversation), not the empty-space one
    else if (n && n.kind === 'recent') target = { kind: 'file', rel: n.f.rel, abs: fileAbs(n.f.key, n.f) || undefined, wrote: !!n.f.wrote, sid: n.s.id };
    else if (n && n.kind === 'pr') target = { kind: 'pr', num: n.num, url: prUrl(n) || undefined, sid: n.sid };
    else if (!n) { const x = hitExtra(sx, sy); if (x && x.kind === 'team') target = { kind: 'team', id: x.id }; }
    if (!target && over && over.kind === 'worktree' && over.hub && over.hub.root) target = { kind: 'repo', root: over.hub.root, name: over.hub.name, color: over.hub.color };
    if (!target) return; // the shell decides about the browser's own menu
    e.preventDefault();
    hideTip();
    try { I.ui.contextMenu(target, e.clientX, e.clientY); } catch (err) { console.error(err); }
  });
  cv.addEventListener('dblclick', (e) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey) return; // multi-select clicks never open anything
    const r = cv.getBoundingClientRect();
    const n = recentClick() || hitTest(e.clientX - r.left, e.clientY - r.top);
    if (n) act(n);
  });
}

// the node the last single click hit, while a double-click on it is still possible
function recentClick() {
  const c = I.lastClick;
  return c && performance.now() - c.t < 700 ? I.byId.get(c.id) || null : null;
}

function openSid(sid) { try { I.ui.open && I.ui.open(sid); } catch { /* shell gone */ } }

// returns true when the key was the map's (the shell then stops there)
// Keys the map doesn't take go on to the overlay (I.overlay.key(e), true when it took the key).
function overlayKey(e) {
  if (!I.overlay || typeof I.overlay.key !== 'function') return false;
  try { return !!I.overlay.key(e); } catch (err) { console.error(err); return false; }
}
function onKey(e) {
  if (!active()) return false;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return false;
  if (e.ctrlKey || e.altKey || e.metaKey) return overlayKey(e);
  const key = e.key;
  const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (key === 'Escape') {
    // the innermost first: the legend, the multi-selection, then the overlay's own (the replay bar); else the
    // shell clears the filter and the pick
    let done = true;
    if (I.legend) setLegend(false);
    else if (I.multi.size || I.multiRepos.size) clearMulti();
    else done = overlayKey(e);
    if (done) e.preventDefault();
    return done;
  }
  let handled = true;
  if (dirs[key]) {
    const [dx, dy] = dirs[key];
    if (e.shiftKey) { I.pan.x += (dx * 90) / K(); I.pan.y += (dy * 90) / K(); I.dirty = true; }
    else moveSel(dx, dy);
  } else if (key === '+' || key === '=' || e.code === 'NumpadAdd') zoomAt(I.W / 2, I.H / 2, 1.25);
  else if (key === '-' || key === '_' || e.code === 'NumpadSubtract') zoomAt(I.W / 2, I.H / 2, 0.8);
  else if (key === '0') recenter(1500);
  else if (key === 'l' || key === 'L') setLegend(!I.legend);
  else if (key === 'g') rearrange(false);
  else if (key === 'G') rearrange(true);
  else if (key === 'k' || key === 'K') {
    // lenses: k the next, K the one before
    const i = LENSES.indexOf(I.lens);
    setMapLens(LENSES[(i + (key === 'k' ? 1 : LENSES.length - 1)) % LENSES.length]);
    flash(`lens: ${I.lens}`);
  }
  else if (key === 'n') nextNeedsYou(1);
  else if (key === 'N') nextNeedsYou(-1);
  // saved views: Shift+1..9 keeps the view, 1..9 glides back to it (e.code: Shift+1 is '!' as a key)
  else if (e.shiftKey && /^Digit[1-9]$/.test(e.code || '')) saveView(e.code.slice(5));
  else if (/^[1-9]$/.test(key)) jumpView(key);
  else if (key === 'Enter' || key === 'o' || key === 'O') {
    const n = I.sel && I.byId.get(I.sel);
    if (!n || !act(n)) handled = false;
  } else handled = false;
  if (!handled) return overlayKey(e);
  e.preventDefault();
  return true;
}

// arrows: the nearest node in that direction, favouring nodes straight ahead
function moveSel(dx, dy) {
  const cur = I.sel ? I.byId.get(I.sel) : null;
  const px = cur ? cur.sx : I.W / 2, py = cur ? cur.sy : I.H / 2;
  let best = null, bs = Infinity;
  for (const n of I.nodes) {
    if (n === cur || n.kind === 'recent' || n.sx === undefined) continue;
    const vx = n.sx - px, vy = n.sy - py;
    const along = vx * dx + vy * dy, perp = Math.abs(vx * dy - vy * dx);
    if (along <= 3) continue;
    const score = along + perp * 2.2 + (n.kind === 'session' ? 0 : 25);
    if (score < bs) { bs = score; best = n; }
  }
  if (!best && !cur) best = I.nodes.find((n) => n.kind === 'session') || null;
  if (best) select(best, true);
}

// ---------- acting on nodes: PR -> GitHub, file -> VS Code, repo -> Explorer ----------
const isHttps = (u) => typeof u === 'string' && /^https:\/\//i.test(u);
function allSessions() {
  const st = I.state || {};
  return Array.isArray(st.allSessions) ? st.allSessions : st.sessions || [];
}
// a shared file's absolute path, from any conversation that touched it (the server only reveals paths it listed)
function fileAbs(key, own) {
  if (own && own.abs) return own.abs;
  for (const s of allSessions()) for (const f of s.files || []) if (f.key === key && f.abs) return f.abs;
  return null;
}
// { hint, run } for a node that does something on double-click / Enter, or null
function nodeAction(n) {
  if (!n) return null;
  if (n.kind === 'pr') {
    const url = prUrl(n);
    return url ? { hint: 'open PR on GitHub', run: () => openUrl(url) } : null;
  }
  if (n.kind === 'recent' || n.kind === 'clash') {
    const abs = n.kind === 'recent' ? fileAbs(n.f.key, n.f) : fileAbs(n.c.key, null);
    return abs ? { hint: 'open the file', run: () => reveal({ kind: 'file', path: abs }) } : null;
  }
  if (n.kind === 'conflict') {
    const f = Array.isArray(n.k.files) && n.k.files.find((x) => x && x.abs);
    return f ? { hint: 'open the migration in VS Code', run: () => reveal({ kind: 'file', path: f.abs }) } : null;
  }
  // (its folder opens from its right-click menu)
  if (n.kind === 'repo') return n.root ? { hint: 'select all its conversations', run: () => { try { I.ui.selectRepo && I.ui.selectRepo(n.root); } catch (err) { console.error(err); } } } : null;
  if ((n.kind === 'session' || n.kind === 'agent') && n.sid) return { hint: 'open the conversation', run: () => openSid(n.sid) };
  return null;
}
// a PR dot's GitHub link: its conversation's, else another one's that shipped the same PR
function prUrl(n) {
  let url = n.s.links && n.s.links.pr;
  if (!isHttps(url)) {
    const o = allSessions().find((s) => s.ship && s.ship.pr === n.num && (s.ship.repo || '') === (n.ship.repo || '') && s.links && isHttps(s.links.pr));
    url = o ? o.links.pr : null;
  }
  return isHttps(url) ? url : null;
}
// runs a node's action once: a click on the picked node followed by a double-click must not open it twice
function act(n) {
  const a = nodeAction(n);
  if (!a) return false;
  const now = performance.now();
  if (I.lastAct && I.lastAct.id === n.id && now - I.lastAct.t < 700) return true;
  I.lastAct = { id: n.id, t: now };
  a.run();
  return true;
}
function openUrl(url) {
  if (!isHttps(url)) return;
  try {
    if (I.ui && typeof I.ui.openUrl === 'function') I.ui.openUrl(url);
    else window.open(url, '_blank', 'noopener');
  } catch { /* shell gone */ }
}
function reveal(req) {
  try {
    if (I.ui && typeof I.ui.reveal === 'function') { I.ui.reveal(req); return; }
    fetch('/reveal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req) }).catch(() => {});
  } catch { /* shell gone */ }
}

// ---------- tooltip ----------
function hideTip() { if (I && I.tip) I.tip.style.display = 'none'; }
// the shell's right-click menu is open: no tooltip comes back over it while the pointer still rests on a node
function menuIsOpen() { try { return !!(I && I.ui && typeof I.ui.menuOpen === 'function' && I.ui.menuOpen()); } catch { return false; } }

function updateTip() {
  const n = (I.hover && I.byId.get(I.hover)) || (I.kbTip && I.sel && I.byId.get(I.sel)) || null;
  const xo = !n && I.hoverX ? I.hoverX : null;
  if ((!n && !xo) || I.drag || menuIsOpen()) { hideTip(); return; }
  const key = (n ? n.id : 'x:' + xo.kind + ':' + xo.id) + '|' + (I.state && I.state.now);
  if (I.tipKey !== key) {
    I.tipKey = key;
    if (n) fillTip(n);
    else if (!fillTipX(xo)) { I.hoverX = null; I.tipKey = null; hideTip(); return; }
  }
  const tip = I.tip;
  tip.style.display = 'block';
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  let x, y;
  if ((I.hover || xo) && I.mouse) {
    x = I.mouse.x + 16; y = I.mouse.y + 14;
    if (x + tw > I.W - 8) x = I.mouse.x - 16 - tw;
    if (y + th > I.H - 8) y = Math.max(8, I.H - 8 - th);
  } else {
    // picked with the keys: sit above the node, clear of its own label underneath
    const r = (n.RG || n.R || 4) + 14;
    x = n.sx - 40; y = n.sy - r - th;
    if (y < 8) y = n.sy + r + 40;
    if (x + tw > I.W - 8) x = I.W - 8 - tw;
    if (y + th > I.H - 8) y = Math.max(8, I.H - 8 - th);
  }
  tip.style.left = Math.max(8, x) + 'px';
  tip.style.top = Math.max(8, y) + 'px';
}

// mono: the value is a path, a branch or a number column (Cascadia Mono); everything else is Segoe UI
function row(parent, label, value, color, mono) {
  const d = document.createElement('div');
  if (label) { const l = document.createElement('span'); l.textContent = label + '  '; l.style.color = COL.dim; d.appendChild(l); }
  const v = document.createElement('span'); v.textContent = value; if (color) v.style.color = color;
  if (mono) v.style.cssText += `;font:11.5px ${CSS_MONO}`;
  d.appendChild(v); parent.appendChild(d); return d;
}
function shipRow(parent, ship) {
  if (!ship || !ship.steps) return;
  const d = document.createElement('div');
  const l = document.createElement('span'); l.textContent = 'ship  '; l.style.color = COL.dim; d.appendChild(l);
  ship.steps.forEach(([name, st], i) => {
    const [g, c] = STEP_LOOK[st] || STEP_LOOK.none;
    const s = document.createElement('span'); s.style.color = c; s.textContent = `${g} ${stepName(name, ship)}`; d.appendChild(s);
    if (i < ship.steps.length - 1) { const sep = document.createElement('span'); sep.textContent = ' ─ '; sep.style.color = COL.faint; d.appendChild(sep); }
  });
  parent.appendChild(d);
}

function fillTip(n) {
  const tip = I.tip, nowC = Date.now() - I.skew;
  tip.textContent = '';
  const head = document.createElement('div');
  head.style.cssText = `font:600 13px/1.35 var(--font-display, ${DISPLAY});margin-bottom:4px`;
  if (n.kind === 'session') {
    const s = n.s;
    const name = document.createElement('span'); name.textContent = s.name || s.id; head.appendChild(name);
    const acc = document.createElement('span'); acc.textContent = '  ' + (s.account || '?'); acc.style.color = accColor(s.account); head.appendChild(acc);
    tip.appendChild(head);
    const st = row(tip, '', s.label || s.state, s.stateColor || COL.dim);
    st.style.cssText += `;font:600 11px ${CSS_UI};letter-spacing:0.06em;margin-bottom:2px`;
    if (s.turnStart && (s.state === 'WORKING' || s.state === 'AGENTS')) st.lastChild.textContent += `   working ${Math.max(0, Math.round((nowC - s.turnStart) / 60e3))}m`;
    else if (NEEDS_YOU.has(s.state) && s.last) st.lastChild.textContent += `   waiting ${Math.max(0, Math.round((nowC - s.last) / 60e3))}m`;
    // what it runs in the background: a server (dev server, emulator) is listed but does not keep it WORKING
    for (const b of (s.background || []).slice(0, 3)) row(tip, b.server ? 'serving' : 'background', `${b.label} · ${Math.max(0, Math.round((nowC - b.t) / 60e3))}m`, b.server ? COL.dim : COL.violet);
    if (s.repo) row(tip, 'repo', s.repo.name + (s.worktree ? ` · ${s.worktree}` : ''), s.repo.color);
    if (s.branch) row(tip, 'branch', s.branch, null, true);
    if (s.model || s.context) {
      const pct = ctxPct(s);
      const d = row(tip, 'model', s.model || '?');
      // its effort in Claude Code's color for that level (app.css .eff-*)
      if (s.effort && /^(low|medium|high|xhigh|max)$/.test(s.effort)) {
        const e = document.createElement('span'); e.textContent = s.effort; e.className = `eff eff-${s.effort}`; e.style.marginLeft = '8px'; d.appendChild(e);
      }
      if (pct !== null) {
        const c = document.createElement('span'); c.textContent = `   ctx ${pct}%`; c.style.cssText = `color:${ctxColor(pct)};font:11.5px ${CSS_MONO}`; d.appendChild(c);
      }
    }
    if (s.goal) row(tip, 'goal', s.goal);
    if (s.lastAction) {
      const a = s.lastAction;
      row(tip, '▸', `${a.who && a.who !== 'main' ? a.who + '  ' : ''}${a.verb || ''} ${a.what || ''}  · ${ago(nowC - a.t)}`);
    }
    if (s.waitingOn && NEEDS_YOU.has(s.state)) {
      const w = row(tip, 'waiting on', s.waitingOn, COL.gold);
      w.style.marginTop = '3px';
    }
    if (s.agents && s.agents.length) {
      const run = s.agents.filter((a) => a.state === 'run').length, fail = s.agents.filter((a) => a.state === 'fail').length;
      row(tip, 'agents', `${run} running · ${s.agents.length - run - fail} done${fail ? ` · ${fail} failed` : ''}`);
    }
    if (s.ship && (s.ship.pr || s.ship.steps)) { shipRow(tip, s.ship); if (s.ship.pr) tip.lastChild.lastChild.after(Object.assign(document.createElement('span'), { textContent: `   PR #${s.ship.pr}`, style: `color:${COL.dim}` })); }
    const clash = I.clashes.filter((c) => c.sessions.some((x) => x.id === s.id));
    for (const c of clash) {
      const others = c.sessions.filter((x) => x.id !== s.id).map((x) => { const o = I.byId.get('s:' + x.id); return o ? o.s.name : x.id; });
      const me = c.sessions.find((x) => x.id === s.id);
      row(tip, '⚠', `also ${me && me.wrote ? 'editing' : 'reading'} ${lastParts(c.rel)} with ${others.join(', ')}`, c.writers >= 2 ? COL.red : COL.gold);
    }
    // its teams: the one it leads first, then the one it reports in (a mid-level lead is in both)
    const tms = I.teams.filter((x) => x.t.members.includes(s.id)).sort((a, b) => (b.lead === s.id) - (a.lead === s.id));
    for (const tm of tms) {
      const others = tm.t.members.filter((id) => id !== s.id).map(nameOf);
      const lead = tm.t.lead && tm.t.members.includes(tm.t.lead) ? tm.t.lead : null;
      row(tip, 'team', lead === s.id ? `★ leads ${tm.t.name || 'team'} · ${others.join(', ')} report to it`
        : lead ? `${tm.t.name || 'team'} · reports to ★ ${nameOf(lead)}` : `${tm.t.name || 'team'} · with ${others.join(', ')}`, tm.t.color || COL.violet);
    }
    if (s.parity && s.parity.partner) {
      const web = s.side && s.side.web, app = s.side && s.side.app;
      row(tip, 'parity', `${web && !app ? 'web side' : app && !web ? 'app side' : 'paired'} · ${web && !app ? 'app' : app && !web ? 'web' : 'other side'}: ${nameOf(s.parity.partner)}`, COL.cyan);
    } else if (s.parity && s.parity.missing) row(tip, 'parity', `changed one side only: no ${s.parity.missing} change yet`, s.parity.missing === 'app' ? COL.mint : COL.cyan);
    if (s.pickedUpFrom && s.pickedUpFrom.id) row(tip, 'picked up from', s.pickedUpFrom.name || s.pickedUpFrom.id, COL.dim);
    if (s.context && s.context.limit && Number(s.context.handoff) > 0 && s.context.handoff < s.context.limit) {
      row(tip, 'handoff at', `${fmtTokens(s.context.handoff)} (the tick on its gauge)`, COL.dim);
    }
    if (I.multi.has(s.id)) row(tip, '', `in the selection (${I.multi.size})`, COL.cyan);
    const u = row(tip, '', `${fmtTokens(s.tokens)} tok  $${(s.cost || 0).toFixed(2)}${s.usagePending ? ' …' : ''}`, COL.dim, true);
    u.style.marginTop = '3px';
    u.append(Object.assign(document.createElement('span'), { textContent: `   · ${ago(nowC - s.last)}`, style: `color:${COL.faint}` }));
  } else if (n.kind === 'agent') {
    head.textContent = n.a.label; tip.appendChild(head);
    row(tip, '', n.a.state === 'run' ? 'running' : n.a.state === 'fail' ? 'failed' : 'done', n.a.state === 'fail' ? COL.red : n.a.state === 'run' ? n.s.hue : COL.dim);
    if (n.a.phase) row(tip, 'phase', n.a.phase);
    row(tip, 'for', n.s.name);
  } else if (n.kind === 'repo') {
    head.textContent = n.name; head.style.color = n.color; tip.appendChild(head);
    row(tip, '', n.root, COL.dim, true);
    row(tip, 'conversations', String(n.sessions.length));
    const dp = I.deploy && I.deploy.get(n.id), d = dp && dp.d;
    if (dp) {
      const text = dp.state === 'building' ? `building${d && d.createdAt ? ` · started ${ago(nowC - d.createdAt)}` : ''}`
        : dp.state === 'failed' ? `deploy failed${d && d.readyAt ? ` · ${ago(nowC - d.readyAt)}` : ''}`
        : `clean, nothing building${d && d.readyAt ? ` · last live ${ago(nowC - d.readyAt)}` : ''}`;
      row(tip, 'production', text, dp.state === 'building' ? COL.gold : dp.state === 'failed' ? COL.red : COL.mint);
      if (d && d.title) row(tip, '', `${d.pr ? `#${d.pr} ` : ''}${d.title}`, COL.dim);
    }
    if (n.wts && n.wts.length) {
      const live = n.wts.filter((w) => w.live).length, stale = n.wts.filter((w) => w.stale);
      row(tip, 'worktrees', `${n.wts.length} · ${live} live${stale.length ? ` · ${stale.length} stale` : ''}`);
      for (const w of stale.slice(0, 8)) row(tip, '  stale', `${w.name} · last commit ${w.lastCommit ? ago(nowC - w.lastCommit) : 'unknown'}`, COL.faint, true);
      if (stale.length > 8) row(tip, '', `+${stale.length - 8} more stale`, COL.faint);
    }
  } else if (n.kind === 'pr') {
    head.textContent = `PR #${n.num}`; tip.appendChild(head);
    if (n.ship.repo) row(tip, '', n.ship.repo, COL.dim, true);
    shipRow(tip, n.ship);
    if (n.ship.fresh) row(tip, '', 'new work since this PR', COL.faint);
    row(tip, 'for', n.s.name);
  } else if (n.kind === 'clash') {
    head.textContent = lastParts(n.c.rel); head.style.color = n.c.writers >= 2 ? COL.red : COL.gold; tip.appendChild(head);
    row(tip, '', n.c.rel, COL.dim, true);
    row(tip, '', n.c.writers >= 2 ? `${n.c.writers} conversations edited it` : 'shared: only one edited it', n.c.writers >= 2 ? COL.red : COL.gold);
    for (const x of n.c.sessions) { const o = I.byId.get('s:' + x.id); row(tip, x.wrote ? '✎' : '·', o ? o.s.name : x.id); }
  } else if (n.kind === 'conflict') {
    const k = n.k, c = conflictColor(k);
    head.textContent = k.kind === 'branch' ? `branch ${k.label}` : k.kind === 'worktree' ? `worktree ${k.label}` : `migration ${k.label}`;
    head.style.color = c; tip.appendChild(head);
    const nm = k.sessions.map(nameOf).join(' and ');
    row(tip, '', k.kind === 'branch' ? `${nm} are on the same branch: pushing from both overwrites each other's work`
      : k.kind === 'worktree' ? `${nm} work live in one worktree folder: they edit the same files on disk`
        : `${nm} wrote migrations with the same number: only one can run`, c);
    if (k.root) row(tip, '', k.root, COL.dim, true);
    for (const f of Array.isArray(k.files) ? k.files : []) row(tip, '✎', `${f.rel} · ${nameOf(f.sid)}`, null, true);
  } else if (n.kind === 'recent') {
    head.textContent = lastParts(n.f.rel); tip.appendChild(head);
    row(tip, '', n.f.rel, COL.dim, true);
    row(tip, n.f.wrote ? '✎ edited' : 'read', `${n.s.name} · ${ago(nowC - n.f.t)}`);
  }
  // what a click does here
  const a = nodeAction(n);
  let hint = null;
  if (n.kind === 'session') hint = 'click: details · double-click / Enter: open the conversation · Ctrl+click: select several';
  else if (a) hint = `double-click / Enter: ${a.hint}`;
  else if (n.kind === 'pr') hint = 'no GitHub link for this PR yet';
  if (n.kind === 'clash' || n.kind === 'conflict' || n.kind === 'recent' || n.kind === 'pr') hint = (hint ? hint + ' · ' : '') + 'right-click: actions';
  if (hint) {
    const h = row(tip, '', hint, COL.dim);
    h.style.cssText += `;margin-top:6px;padding-top:5px;border-top:1px solid var(--line, rgba(120,130,170,0.18));font:11px ${CSS_UI}`;
  }
}
// a conversation's name by id (on the map, or anywhere in the state)
function nameOf(id) {
  const n = I.byId.get('s:' + id);
  if (n && n.s) return n.s.name || id;
  const s = allSessions().find((x) => x.id === id);
  return (s && s.name) || id;
}
// the tooltip for things that aren't nodes: a worktree, a parity ghost, a team, a parity line, a handoff trail.
// Returns false when it's gone.
function fillTipX(x) {
  const tip = I.tip, nowC = Date.now() - I.skew;
  tip.textContent = '';
  const head = document.createElement('div');
  head.style.cssText = `font:600 13px/1.35 var(--font-display, ${DISPLAY});margin-bottom:4px`;
  const hint = (text) => { const h = row(tip, '', text, COL.dim); h.style.cssText += `;margin-top:6px;padding-top:5px;border-top:1px solid var(--line, rgba(120,130,170,0.18));font:11px ${CSS_UI}`; };
  if (x.kind === 'worktree') {
    const w = x.w;
    head.textContent = w.name || 'worktree'; head.style.color = (x.hub && x.hub.color) || COL.text; tip.appendChild(head);
    if (w.branch) row(tip, 'branch', w.branch, null, true);
    row(tip, '', w.path, COL.dim, true);
    row(tip, 'last commit', w.lastCommit ? ago(nowC - w.lastCommit) : 'unknown');
    row(tip, '', w.live ? 'a live conversation works here' : w.stale ? 'stale: nothing live, no commit for 3+ days' : 'no live conversation here', w.live ? COL.mint : w.stale ? COL.faint : COL.dim);
    return true;
  }
  if (x.kind === 'ghost') {
    const g = x.g, s = g.n.s;
    head.textContent = g.missing === 'web' ? 'no web change' : 'no app change'; head.style.color = g.col; tip.appendChild(head);
    row(tip, '', `${s.name} changed the ${g.missing === 'web' ? 'phone app' : 'website'} only, and no partner conversation covers the ${g.missing === 'web' ? 'website' : 'app'}`);
    row(tip, '', 'web and app ship together: make the same change on the other side, or say why in the PR', COL.dim);
    return true;
  }
  if (x.kind === 'team') {
    const tm = I.teams.find((t) => t.t.id === x.id);
    if (!tm) return false;
    const t = tm.t;
    head.textContent = t.name || 'team'; head.style.color = t.color || COL.violet; tip.appendChild(head);
    const lead = t.lead && t.members.includes(t.lead) ? t.lead : null;
    if (lead) {
      row(tip, 'lead', `★ ${nameOf(lead)}: directs the others; they report to it`, t.color || COL.violet);
      row(tip, 'members', t.members.filter((id) => id !== lead).map(nameOf).join(', '));
    } else row(tip, 'members', `${t.members.map(nameOf).join(', ')} (peers: no lead)`);
    if (t.order) {
      const o = row(tip, 'order', t.order.length > 360 ? t.order.slice(0, 359) + '…' : t.order);
      if (t.at) o.append(Object.assign(document.createElement('span'), { textContent: `  · ${ago(nowC - t.at)}`, style: `color:${COL.faint}` }));
    }
    const msgs = (Array.isArray(t.messages) ? t.messages : []).slice(-4);
    if (msgs.length) {
      const h = row(tip, '', 'last messages', COL.dim); h.style.marginTop = '4px';
      for (const m of msgs) {
        const text = String(m.text || '');
        const r = row(tip, `${nameOf(m.from)} → ${nameOf(m.to)}`, text.length > 160 ? text.slice(0, 159) + '…' : text);
        r.append(Object.assign(document.createElement('span'), { textContent: `  · ${ago(nowC - m.t)}`, style: `color:${COL.faint}` }));
      }
    }
    hint('right-click: message the team, choose its lead, add, disband');
    return true;
  }
  if (x.kind === 'parity' && x.l) {
    head.textContent = 'web ↔ app'; tip.appendChild(head);
    row(tip, 'web', x.l.a.s.name, COL.cyan);
    row(tip, 'app', x.l.b.s.name, COL.mint);
    row(tip, '', 'partners: one change, made on both sides', COL.dim);
    return true;
  }
  if (x.kind === 'handoff' && x.l) {
    head.textContent = 'handoff'; tip.appendChild(head);
    row(tip, '', `${x.l.a.s.name} → ${x.l.b.s.name}`);
    row(tip, '', 'picked up where the earlier conversation stopped', COL.dim);
    return true;
  }
  return false;
}
function fmtTokens(t) {
  t = t || 0;
  if (t >= 1e9) return (t / 1e9).toFixed(1) + 'B';
  if (t >= 1e6) return (t / 1e6).toFixed(1) + 'M';
  if (t >= 1e3) return Math.round(t / 1e3) + 'k';
  return String(t);
}

// ---------- legend ----------
function setLegend(on) {
  if (!I) return;
  I.legend = on;
  if (I.legendEl) I.legendEl.style.display = on ? 'block' : 'none';
  if (I.hintEl) I.hintEl.style.display = on ? 'none' : 'block';
}

function buildLegend() {
  const NS = 'http://www.w3.org/2000/svg';
  const wrapEl = document.createElement('div');
  const title = document.createElement('div');
  title.textContent = 'Map legend';
  title.style.cssText = `flex:1 1 auto;font:600 13px var(--font-display, ${DISPLAY});color:${COL.text}`;
  // a × beside the title closes it (as l and Esc do)
  const head = document.createElement('div');
  head.style.cssText = 'display:flex;align-items:center;gap:8px;margin:-4px -6px 4px 0';
  const x = document.createElement('button');
  x.type = 'button'; x.title = 'close (l or Esc)'; x.setAttribute('aria-label', 'close the legend');
  x.style.cssText = `flex:none;display:grid;place-items:center;width:26px;height:26px;padding:0;border:0;border-radius:7px;background:transparent;color:${COL.dim};cursor:pointer`;
  x.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
  x.addEventListener('mouseenter', () => { x.style.background = 'rgba(255,255,255,0.07)'; x.style.color = COL.text; });
  x.addEventListener('mouseleave', () => { x.style.background = 'transparent'; x.style.color = COL.dim; });
  x.addEventListener('pointerdown', (e) => e.stopPropagation());
  x.addEventListener('click', (e) => { e.stopPropagation(); setLegend(false); });
  head.append(title, x);
  wrapEl.appendChild(head);
  let gid = 0;
  // an orb like the map's: lighter top left, the hue, a darker rim
  const orbSvg = (cx, cy, r, color, op = 1) => {
    const id = 'fvorb' + ++gid;
    return `<defs><radialGradient id="${id}" cx="0.32" cy="0.29" r="0.75"><stop offset="0" stop-color="${mix(color, WHITE, 0.55)}"/>` +
      `<stop offset="0.5" stop-color="${color}"/><stop offset="1" stop-color="${mix(color, BLACK, 0.45)}"/></radialGradient></defs>` +
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${id})" opacity="${op}"/>`;
  };
  const icon = (svg) => {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('width', '30'); s.setAttribute('height', '20'); s.setAttribute('viewBox', '0 0 30 20');
    s.style.cssText = 'flex:none;margin-right:10px';
    s.innerHTML = svg; return s;
  };
  const item = (svg, text) => {
    const d = document.createElement('div');
    d.style.cssText = 'display:flex;align-items:center;margin:2px 0';
    d.appendChild(icon(svg));
    const t = document.createElement('span'); t.textContent = text; d.appendChild(t);
    wrapEl.appendChild(d);
  };
  const sec = (text) => {
    const d = document.createElement('div'); d.textContent = text;
    d.style.cssText = `color:${COL.dim};font:600 10px ${CSS_UI};margin:9px 0 3px;letter-spacing:0.08em;text-transform:uppercase`;
    wrapEl.appendChild(d);
  };
  const track = `<circle cx="15" cy="10" r="7.5" fill="none" stroke="${rgba(COL.dim, 0.18)}" stroke-width="2.5"/>`;
  const arc = (d, c) => `<path d="${d}" fill="none" stroke="${c}" stroke-width="2.5" stroke-linecap="round"/>`;
  sec('Conversations');
  item(orbSvg(15, 10, 6, COL.cyan), 'working (an orb in its colour)');
  item(orbSvg(15, 10, 5, COL.violet) + orbSvg(5, 10, 2, COL.violet) + orbSvg(25, 10, 2, COL.violet) + orbSvg(15, 2.2, 1.8, COL.violet, 0.45), 'agents running (orbs around it)');
  item(`<circle cx="15" cy="10" r="6.5" fill="${rgba(COL.gold, 0.14)}" stroke="${COL.gold}" stroke-width="1.8"/>` + orbSvg(15, 10, 2.6, COL.gold), 'needs you (blocked on a question or permission)');
  item(`<circle cx="15" cy="10" r="6.5" fill="${rgba(COL.gold, 0.14)}"/><path d="M19.98 5.82A6.5 6.5 0 1 1 10.02 5.82" fill="none" stroke="${COL.gold}" stroke-width="1.8" stroke-linecap="round"/>`
    + orbSvg(15, 10, 2.6, COL.gold), 'asked you (its reply ends on a question; the ring is open)');
  item(`<circle cx="15" cy="10" r="6.5" fill="none" stroke="${rgba(COL.gold, 0.6)}" stroke-width="2" stroke-linecap="round" stroke-dasharray="0.1 3.6"/>`, 'stalled? (quiet 5 min mid-turn)');
  item(`<circle cx="15" cy="10" r="6.5" fill="${rgba(COL.red, 0.14)}" stroke="${COL.red}" stroke-width="1.8"/><path d="M12.6 7.6l4.8 4.8M17.4 7.6l-4.8 4.8" stroke="${COL.red}" stroke-width="1.6" stroke-linecap="round"/>`, 'API error');
  item(orbSvg(15, 10, 4.4, mixHex(COL.cyan, COL.faint, 0.5)), 'finished, in "Recently finished" (smaller and muted, on its repo; removing it there removes it here)');
  item(`<circle cx="15" cy="10" r="6.5" fill="${rgba(COL.accB, 0.12)}" stroke="${COL.accB}" stroke-width="1.6" stroke-dasharray="3 3"/>`, 'new session, no message yet (dashed in its account colour)');
  sec('Context gauge');
  item(track + arc('M15 2.5 A7.5 7.5 0 0 1 22.5 10', COL.mint), 'under 70% of context used');
  item(track + arc('M15 2.5 A7.5 7.5 0 1 1 7.9 7.7', COL.gold), '70–90%');
  item(track + arc('M15 2.5 A7.5 7.5 0 1 1 12.7 2.9', COL.red), 'over 90%');
  sec('Other nodes');
  const hub = (c) => {
    const hex = (r) => Array.from({ length: 6 }, (_, i) => { const a = -Math.PI / 2 + (i * Math.PI) / 3; return `${(15 + Math.cos(a) * r).toFixed(2)},${(10 + Math.sin(a) * r).toFixed(2)}`; }).join(' ');
    const arcs = Array.from({ length: 6 }, (_, i) => {
      const a0 = 0.3 + (i * Math.PI) / 3, a1 = a0 + (Math.PI / 3) * 0.64, R = 7.4;
      return `M${(15 + Math.cos(a0) * R).toFixed(2)} ${(10 + Math.sin(a0) * R).toFixed(2)}A${R} ${R} 0 0 1 ${(15 + Math.cos(a1) * R).toFixed(2)} ${(10 + Math.sin(a1) * R).toFixed(2)}`;
    }).join('');
    const id = 'fvhub' + ++gid;
    return `<defs><linearGradient id="${id}" x1="0.25" y1="0" x2="0.75" y2="1"><stop offset="0" stop-color="${mix(c, WHITE, 0.42)}"/><stop offset="0.5" stop-color="${c}"/>` +
      `<stop offset="1" stop-color="${mix(c, BLACK, 0.38)}"/></linearGradient></defs>` +
      `<path d="${arcs}" fill="none" stroke="${rgba(c, 0.66)}" stroke-width="1.3" stroke-linecap="round"/>` +
      `<polygon points="${hex(4.6)}" fill="url(#${id})" stroke="rgba(255,255,255,0.24)" stroke-width="0.8"/><polygon points="${hex(1.6)}" fill="${mix(c, WHITE, 0.5)}"/>`;
  };
  item(hub(COL.ember), 'repo: a hub in its colour, its ring turns slowly and nudges when work arrives (its glow: a faint cloud around it and its conversations)');
  const vtri = (cx, c) => `<circle cx="${cx}" cy="10" r="5.6" fill="${HOLE}" stroke="${rgba(c, 0.55)}" stroke-width="1"/><path d="M${cx} 6.6l3.6 5.6h-7.2z" fill="${c}"/>`;
  item(`<circle cx="15" cy="10" r="7.6" fill="none" stroke="${rgba(COL.gold, 0.16)}" stroke-width="2"/><path d="M15 2.4A7.6 7.6 0 0 1 22.6 10" fill="none" stroke="${COL.gold}" stroke-width="2" stroke-linecap="round"/>` + vtri(15, COL.gold), 'repo deploying to production (Vercel): gold arc turning round the hub');
  item(vtri(9, COL.mint) + vtri(22, COL.red), 'repo on production: clean, nothing building · last deploy failed');
  item(orbSvg(9, 10, 3.2, COL.cyan) + orbSvg(21, 10, 2.8, COL.cyan, 0.42), 'agent running · done');
  item(`<path d="M12 7l6 6M18 7l-6 6" stroke="${COL.red}" stroke-width="1.8" stroke-linecap="round"/>`, 'agent failed');
  const pr = (cx, c) => `<circle cx="${cx}" cy="10" r="4.6" fill="${rgba(c, 0.2)}" stroke="${c}" stroke-width="1.3"/>` +
    `<path d="M${cx - 1.4} 8.6v2.8M${cx + 1.4} 11.2v-1.8q0 -1.1 -1.2 -1.1" fill="none" stroke="${c}" stroke-width="0.8" stroke-linecap="round"/>` +
    `<g fill="${c}"><circle cx="${cx - 1.4}" cy="8.1" r="0.7"/><circle cx="${cx - 1.4}" cy="11.9" r="0.7"/><circle cx="${cx + 1.4}" cy="11.9" r="0.7"/></g>`;
  item(pr(5, COL.gold) + pr(15, COL.cyan) + pr(25, COL.violet), 'PR: checks running · passed · merged');
  item(pr(9, COL.mint) + pr(21, COL.red), 'PR: live · failed');
  sec('Files');
  item(`<path d="M2 10 H28" stroke="${COL.red}" stroke-width="1.4" stroke-dasharray="5 3" opacity="0.7"/>` + orbSvg(15, 10, 3.6, COL.red), 'same file edited by 2+ conversations');
  item(`<path d="M2 10 H28" stroke="${COL.gold}" stroke-width="1.4" stroke-dasharray="5 3" opacity="0.7"/>` + orbSvg(15, 10, 3.6, COL.gold), 'shared file, only one edits it');
  item(`<path d="M3 13 Q15 6 26 10" fill="none" stroke="${COL.cyan}" stroke-width="1.1" opacity="0.7"/><circle cx="27" cy="10" r="2.4" fill="${COL.cyan}"/>`, 'file edited, last 10 min (fades with age)');
  item(`<path d="M3 13 Q15 6 26 10" fill="none" stroke="${COL.cyan}" stroke-width="1" stroke-dasharray="2 3" opacity="0.5"/><circle cx="27" cy="10" r="2" fill="none" stroke="${COL.dim}" stroke-width="1.1"/>`, 'file read, last 10 min');
  sec('Working together');
  item(`<circle cx="15" cy="10" r="6" fill="none" stroke="${COL.cyan}" stroke-width="1.1"/><circle cx="15" cy="10" r="8.6" fill="none" stroke="${COL.cyan}" stroke-width="1.1"/>` + orbSvg(15, 10, 3.6, COL.cyan),
    'in the selection (Ctrl+click, Ctrl+drag; right-click: orders for all)');
  const braid = (c) => `<path d="M2 10 C6 6 9 6 12 10 S18 14 21 10 S26 6 28 10" fill="none" stroke="${rgba(c, 0.6)}" stroke-width="1.1"/>` +
    `<path d="M2 10 C6 14 9 14 12 10 S18 6 21 10 S26 14 28 10" fill="none" stroke="${rgba(c, 0.6)}" stroke-width="1.1"/>`;
  item(braid('#ff9f43'), 'a team: members braided in its colour, its name on a pill (hover: the order and messages)');
  const star = (x, y, ro, c) => `<path d="${Array.from({ length: 10 }, (_, i) => { const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? ro * 0.42 : ro; return `${i ? 'L' : 'M'}${(x + Math.cos(a) * r).toFixed(2)} ${(y + Math.sin(a) * r).toFixed(2)}`; }).join(' ')}Z" fill="${c}"/>`;
  item(`<path d="M8 10 L27 4 M8 10 L27 16" stroke="${rgba('#ff9f43', 0.6)}" stroke-width="1.1"/>` + orbSvg(8, 10, 3.6, '#ff9f43') + star(12, 6, 3, '#ff9f43'),
    'a team with a lead (★): spokes from the lead to each member; they report to it, not to each other');
  item(`<path d="M2 10 H28" stroke="${COL.dim}" stroke-width="1" opacity="0.6"/>` + orbSvg(15, 10, 2.4, '#ff9f43'), 'a message between teammates travels along the link');
  item(`<defs><linearGradient id="fvpar" gradientUnits="userSpaceOnUse" x1="3" y1="10" x2="27" y2="10"><stop offset="0" stop-color="${COL.cyan}"/><stop offset="1" stop-color="${COL.mint}"/></linearGradient></defs>` +
    `<path d="M3 10 H27" stroke="url(#fvpar)" stroke-width="1.6" stroke-linecap="round" stroke-dasharray="0.1 4"/>`, 'web ↔ app partners (website side cyan, app side mint)');
  item(orbSvg(8, 10, 4, COL.cyan) + `<path d="M13 10 H20" stroke="${rgba(COL.mint, 0.5)}" stroke-dasharray="2 3"/><circle cx="24" cy="10" r="3.6" fill="none" stroke="${rgba(COL.mint, 0.7)}" stroke-width="1.1" stroke-dasharray="2 3"/>`,
    'changed one side only: "no app change" (or web)');
  item(`<path d="M3 10 H22" stroke="${rgba(COL.dim, 0.5)}" stroke-width="1"/><path d="M27 10 L21 7 L21 13 Z" fill="${rgba(COL.dim, 0.6)}"/>`, 'handoff: from the conversation it was picked up from');
  item(track + arc('M15 2.5 A7.5 7.5 0 0 1 22.5 10', COL.mint) + `<path d="M21.2 14.4 L24.2 16.6" stroke="${COL.text}" stroke-width="1.3"/>`, 'the tick on the gauge: where it should hand off');
  sec('Conflicts (right-click: actions)');
  const cring = (c, glyph) => `<circle cx="15" cy="10" r="6.5" fill="${rgba(c, 0.16)}" stroke="${c}" stroke-width="1.3"/>${glyph}`;
  item(cring(COL.gold, `<path d="M13 6.6v6.8M16.9 7.6q0 3.2 -3.9 3.6" fill="none" stroke="${COL.gold}" stroke-width="1"/>`), 'two conversations on one branch');
  item(cring(COL.red, `<path d="M11.8 7.6h2.2l0.8 0.9h3.4v4.3h-6.4z" fill="none" stroke="${COL.red}" stroke-width="1"/>`), 'two live in one worktree folder');
  item(`<rect x="3" y="4" width="24" height="12" rx="6" fill="${rgba(COL.red, 0.16)}" stroke="${COL.red}" stroke-width="1.2"/>` +
    `<text x="15" y="13.2" text-anchor="middle" font-family="Cascadia Mono, Consolas, monospace" font-weight="700" font-size="6.6" fill="${COL.red}">#0142</text>`, 'two migrations with one number');
  sec('Repos and shipping');
  item(hub(COL.mint) + `<rect x="13.5" y="0.2" width="3" height="3" rx="0.8" fill="${COL.mint}"/>`,
    'worktree a live conversation works in (idle ones: hover the hub)');
  item(pr(13, COL.gold) + `<rect x="19" y="3" width="5" height="8" rx="1.3" fill="none" stroke="${COL.gold}" stroke-width="1.1"/>`, 'PR shipping to the phones (the badge: the app step)');
  sec('Lenses (k)');
  item(orbSvg(6, 10, 2.6, COL.mint) + orbSvg(15, 10, 4, COL.gold) + orbSvg(25, 10, 5.4, COL.red), 'cost: bigger and hotter as it costs more');
  // the accounts in the legend: up to 3 fit its 30 px swatch
  const accs = [...accSeen].sort().slice(0, 3), accX = (i) => (accs.length > 2 ? 5 + i * 10 : 8 + i * 14);
  item(accs.map((a, i) => orbSvg(accX(i) + (accs.length > 2 ? 0 : 1), 10, accs.length > 2 ? 3.4 : 4, ACC_COL[a] || COL.dim)).join(''), 'account: ' + accs.join(' · '));
  item(orbSvg(9, 10, 4, COL.cyan) + orbSvg(21, 10, 4, mixHex(COL.cyan, COL.faint, 0.8)), 'idle: fresh · quiet for an hour');
  item(orbSvg(6, 10, 3.6, COL.mint) + orbSvg(15, 10, 3.6, COL.gold) + orbSvg(24, 10, 3.6, COL.red), 'context: little · much · nearly full');
  sec('Double-click (or click when picked)');
  const act = (text) => { const d = document.createElement('div'); d.textContent = text; d.style.cssText = 'margin:1px 0 1px 40px'; wrapEl.appendChild(d); };
  act('conversation: open it (one click shows details)');
  act('PR: open it on GitHub');
  act('file: click to open it (VS Code, or its own app for images and documents)');
  act('repo: select all its conversations (double-click)');
  act('right-click a conversation, a repo, a team or a conflict: its menu');
  sec('Accounts');
  const small = accs.length > 2;
  const acc = (cx, c, t) => `<circle cx="${cx}" cy="10" r="${small ? 4.8 : 6.5}" fill="${rgba(c, 0.2)}" stroke="${rgba(c, 0.55)}"/>` +
    `<text x="${cx}" y="${small ? 12.5 : 13.2}" text-anchor="middle" font-family="Segoe UI Variable Text, Segoe UI" font-weight="700" font-size="${small ? 7 : 9}" fill="${c}">${t}</text>`;
  item(accs.map((a, i) => acc(accX(i), ACC_COL[a] || COL.dim, a)).join(''), 'Claude account ' + accs.join(' · '));
  const keys = document.createElement('div');
  keys.style.cssText = `margin-top:10px;padding-top:8px;border-top:1px solid var(--line, rgba(120,130,170,0.18));color:${COL.dim};font:11px ${CSS_UI}`;
  keys.textContent = 'wheel zoom · drag pan · drag a repo or conversation to pin it · g re-arrange (G unpins all) · 0 recenter · arrows pick · Enter/o open or act · ' +
    'Ctrl+click select · Ctrl+drag on empty space select an area · Esc clear · n / N next that needs you · k lens · Shift+1..9 save a view, 1..9 go back · l close';
  wrapEl.appendChild(keys);
  return wrapEl;
}
