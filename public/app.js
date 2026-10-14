(() => {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------------------------------------------------------------------------
  // The world. Every scene shares this layout (SVG units, viewBox 1000 wide).
  // ---------------------------------------------------------------------------
  const GROUND = 200;
  const START_X = 72;
  const CX = [250, 345, 440, 535, 630];          // crate centres
  const STAND = i => CX[i] - 46;                 // where the agent stands to open crate i
  const FX = 786, FY = 38, FW = 150, FH = 100;   // picture frame (inner)
  const HOLE_X = 52, HOLE_Y = 36;                // missing piece, inside the frame
  const HOLE_CX = FX + HOLE_X + 17, HOLE_CY = FY + HOLE_Y + 17;
  const PLACE_X = 770, CHECK_X = 690;
  const PIECE = 'M0,0 H11 A7,7 0 1,1 23,0 H34 V11 A7,7 0 1,1 34,23 V34 H0 Z';
  // Things the agent adds that nobody asked for, in picture coordinates (origin = item's anchor).
  const EXTRAS = [
    { at: [126, 57], box: [-13, -15, 26, 26], svg:
      '<path d="M-8,-1 L0,-9 L8,-1 Z" fill="#d1495b"/><rect x="-6.5" y="-1.5" width="13" height="10" fill="#fff6e0"/><rect x="-2" y="3" width="4" height="5.5" fill="#8a5a3c"/>' },
    { at: [82, 16], box: [-11, -9, 22, 15], svg:
      '<path d="M-7,0 Q-3.5,-5 0,0 Q3.5,-5 7,0" fill="none" stroke="#2f3a4a" stroke-width="2" stroke-linecap="round"/>' },
    { at: [22, 55], box: [-10, -16, 20, 26], svg:
      '<rect x="-1.5" y="0" width="3" height="7" fill="#8a5a3c"/><circle cy="-5" r="7.5" fill="#2e7d4f"/>' },
  ];
  const TEMPO = 0.8;                             // seconds per scripted "beat second"
  const WALK = 330;                              // walking speed, units per beat second

  // ---------------------------------------------------------------------------
  // Effort levels: the only thing that differs between agents.
  // ---------------------------------------------------------------------------
  const LEVELS = [
    { id: 'low', think: 0.45, sketches: 0, strategy: 'grab', checks: [],
      blurb: 'Grabs the first piece. Never looks back.' },
    { id: 'medium', think: 1.2, sketches: 1, strategy: 'scan', compare: 0.6,
      checks: [{ depth: 'glance', dur: 0.7 }],
      blurb: 'A quick look around, a quick glance at the result.' },
    { id: 'high', think: 2.0, sketches: 2, strategy: 'scan', compare: 0.75,
      checks: [{ depth: 'thorough', dur: 1.5 }],
      blurb: 'Thinks first. Checks its work and fixes what it finds.' },
    { id: 'xhigh', think: 2.8, sketches: 3, strategy: 'survey', compare: 0.9,
      checks: [{ depth: 'thorough', dur: 1.3 }, { depth: 'thorough', dur: 1.1 }],
      blurb: 'Looks at every option before choosing.' },
    { id: 'max', think: 3.8, sketches: 4, strategy: 'survey', compare: 1.1, reconsider: 1.5,
      checks: [{ depth: 'thorough', dur: 1.3 }, { depth: 'thorough', dur: 1.1 }, { depth: 'thorough', dur: 1.0 }],
      polish: 1.3,
      blurb: 'Everything, twice, with a polish on top.' },
  ];
  LEVELS.forEach((l, i) => { l.idx = i; });

  // ---------------------------------------------------------------------------
  // Models: the same five levels play out a little differently on each.
  // Paraphrased from Anthropic's migration guidance for each model.
  //   def      the API's default effort level (index into LEVELS)
  //   think    thinking time multiplier per level
  //   extras   unrequested additions per level, by task ("does more than you asked")
  //   checkIn  levels that stop to ask before finishing, and on which tasks
  // ---------------------------------------------------------------------------
  const NONE = [0, 0, 0, 0, 0];
  const MODELS = {
    'fable-5.1': {
      label: 'Fable 5.1', def: 2,
      think: [1, 1, 1.1, 1.2, 1.3],
      extras: { easy: [0, 0, 1, 2, 3], tricky: [0, 0, 0, 1, 2], hard: NONE },
      note: 'Default is high. At higher effort on routine jobs, it tends to do more than you asked.',
    },
    'opus-5.5': {
      label: 'Opus 5.5', def: 1,
      think: [1, 1, 1, 1.25, 1.4],
      extras: { easy: [0, 0, 0, 1, 2], tricky: [0, 0, 0, 0, 1], hard: NONE },
      note: 'Default is medium. At xhigh and max, it thinks longer per turn than earlier Opus models.',
    },
    'sonnet-5.5': {
      label: 'Sonnet 5.5', def: 2,
      think: [0.35, 1, 1, 1, 1],
      extras: { easy: [0, 0, 0, 0, 1], tricky: NONE, hard: NONE },
      checkIn: { levels: [0], tasks: ['tricky', 'hard'] },
      note: 'Default is high. At low, it skips thinking on simple jobs and may stop to check in before finishing.',
    },
  };

  // What is in each crate: 0 = the right piece, 1 = nearly right, 2 = obviously wrong.
  const TASKS = {
    easy:   { label: 'Easy',   m: [0, 2, 2, 2, 2] },
    tricky: { label: 'Tricky', m: [2, 0, 2, 1, 2] },
    hard:   { label: 'Hard',   m: [1, 2, 2, 0, 2] },
  };

  // ---------------------------------------------------------------------------
  // Planner: turns a level + task into a timeline of beats.
  // ---------------------------------------------------------------------------
  function buildPlan(L, taskId, modelId) {
    const M = MODELS[modelId];
    const m = TASKS[taskId].m;
    const thinkK = M.think[L.idx];
    const extras = M.extras[taskId][L.idx];
    const checkIn = !!M.checkIn && M.checkIn.levels.includes(L.idx) && M.checkIn.tasks.includes(taskId);
    const beats = [];
    let t = 0, x = START_X;
    const add = (type, dur, phase, d) => {
      const b = Object.assign({ type, t0: t, dur: dur * TEMPO, phase }, d || {});
      beats.push(b);
      t += b.dur;
    };
    const walk = (to, phase) => {
      const d = Math.abs(to - x);
      if (d < 2) return;
      add('walk', 0.12 + d / WALK, phase, { from: x, to });
      x = to;
    };
    const scan = (from, careful) => {
      for (let i = from; i < 5; i++) {
        walk(STAND(i), 'look');
        add('open', 0.3, 'look', { c: i });
        const ok = careful ? m[i] === 0 : m[i] < 2;
        add('inspect', careful ? L.compare * 1.3 : L.compare, 'look', { c: i, ok });
        if (ok) { add('pick', 0.45, 'do', { c: i, from: 'lifted' }); return i; }
        add('lower', 0.3, 'look', { c: i });
      }
      return m.indexOf(0);
    };

    add('wake', 0.7, 'idle');
    add('think', L.think * thinkK, 'think', { kind: 'plan', n: L.sketches });

    let c;
    if (L.strategy === 'grab') {
      walk(STAND(0), 'look');
      add('open', 0.25, 'look', { c: 0 });
      add('pick', 0.35, 'do', { c: 0, from: 'open' });
      if (checkIn) add('checkin', 2.6, 'wait');
      c = 0;
    } else if (L.strategy === 'scan') {
      c = scan(0, false);
    } else {
      for (let i = 0; i < 5; i++) {
        walk(STAND(i), 'look');
        add('open', 0.3, 'look', { c: i });
        add('inspect', L.compare, 'look', { c: i, ok: m[i] === 0 });
        add('lower', 0.3, 'look', { c: i });
      }
      if (L.reconsider) add('think', L.reconsider * thinkK, 'think', { kind: 'compare', marks: m.map(v => v === 0) });
      c = m.indexOf(0);
      walk(STAND(c), 'do');
      add('pick', 0.5, 'do', { c, from: 'closed' });
    }

    walk(PLACE_X, 'do');
    add('place', 0.7, 'do', { c });

    for (let k = 0, guard = 0; k < L.checks.length && guard < 8; k++, guard++) {
      const ck = L.checks[k];
      walk(CHECK_X, 'check');
      const detect = ck.depth === 'thorough' ? m[c] >= 1 : m[c] >= 2;
      add('check', ck.dur, 'check', { depth: ck.depth, detect, c });
      if (detect) {
        add('alarm', 0.6, 'check');
        walk(PLACE_X, 'do');
        add('remove', 0.55, 'do', { c });
        walk(STAND(c), 'do');
        add('putback', 0.45, 'do', { c });
        c = scan(c + 1, true);
        walk(PLACE_X, 'do');
        add('place', 0.7, 'do', { c });
        k = -1; // start the checks over on the new piece
      }
    }
    if (L.polish) { walk(PLACE_X, 'check'); add('polish', L.polish, 'check'); }
    if (extras) {
      walk(PLACE_X, 'extra');
      for (let k = 0; k < extras; k++) add('extra', 1.4, 'extra', { k });
    }

    const ok = m[c] === 0;
    add('done', 0.9, 'idle', { ok });
    add('stamp', 1.0, 'idle', { ok, c });

    // merged phase segments for the timeline strips
    const segs = [];
    for (const b of beats) {
      const last = segs[segs.length - 1];
      if (last && last.phase === b.phase) last.dur += b.dur;
      else segs.push({ phase: b.phase, t0: b.t0, dur: b.dur });
    }
    return { level: L, task: taskId, model: modelId, m, beats, segs, total: t, ok, extras, checkIn };
  }

  // ---------------------------------------------------------------------------
  // State at time t: replay every beat that has started.
  // ---------------------------------------------------------------------------
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, p) => a + (b - a) * p;
  const ease = p => p * p * (3 - 2 * p);
  const backOut = p => { const s = 1.9; p -= 1; return p * p * ((s + 1) * p + s) + 1; };

  function freshState() {
    return {
      ax: START_X, face: 1, pose: 'idle', expr: 'neutral', walk: 0, jump: 0,
      phase: 'idle', bubble: null, mag: false, scan: null, mark: null, flaw: 0,
      crates: [0, 1, 2, 3, 4].map(() => ({ lid: 0, mark: null })),
      pieces: [0, 1, 2, 3, 4].map(() => ({ mode: 'crate', p: 0 })),
      held: null, placed: null, stamp: null, sparkle: 0, speech: null, added: [0, 0, 0],
      looked: 0, checks: 0, fixes: 0, extras: 0, thought: 0, finished: false,
    };
  }

  const APPLY = {
    wake(S, b, p) {
      S.expr = 'curious';
      S.mark = p > 0.15 && p < 0.92 ? '?' : null;
    },
    think(S, b, p) {
      S.pose = 'think'; S.expr = 'think';
      S.bubble = { kind: b.kind, n: b.n, marks: b.marks, p, dur: b.dur };
      S.thought += b.dur * p;
    },
    walk(S, b, p) {
      const k = ease(p);
      S.ax = lerp(b.from, b.to, k);
      S.face = b.to >= b.from ? 1 : -1;
      S.walk += Math.abs(S.ax - b.from);
      S.pose = S.held !== null ? 'carryWalk' : 'walk';
    },
    open(S, b, p) {
      S.pose = 'reach'; S.face = 1;
      S.crates[b.c].lid = ease(p);
      S.looked++;
    },
    inspect(S, b, p) {
      S.pose = 'inspect'; S.face = 1; S.expr = 'focus'; S.mag = true;
      S.pieces[b.c] = p < 0.25 ? { mode: 'rising', p: p / 0.25 } : { mode: 'lifted' };
      if (p > 0.8) {
        S.crates[b.c].mark = b.ok ? 'ok' : 'no';
        S.expr = b.ok ? 'nod' : 'meh';
      }
    },
    lower(S, b, p) {
      S.pose = 'reach'; S.face = 1;
      S.pieces[b.c] = { mode: 'sinking', p };
      S.crates[b.c].lid = 1 - ease(p);
    },
    pick(S, b, p) {
      S.pose = p > 0.5 ? 'carry' : 'reach'; S.face = 1;
      S.pieces[b.c] = { mode: 'toHand', p, from: b.from };
      const cr = S.crates[b.c];
      cr.lid = b.from === 'closed' ? Math.sin(Math.PI * p) : 1 - ease(p);
      S.held = b.c;
    },
    place(S, b, p) {
      S.pose = 'place'; S.face = 1;
      S.pieces[b.c] = { mode: 'placing', p };
      if (p >= 1) { S.held = null; S.placed = b.c; S.pieces[b.c] = { mode: 'placed' }; }
    },
    check(S, b, p) {
      S.pose = 'check'; S.face = 1; S.expr = 'focus'; S.mag = true;
      S.scan = { p, depth: b.depth };
      S.checks++;
      if (b.detect && p > 0.5) { S.flaw = (p - 0.5) / 0.5; S.expr = 'alarm'; }
      else if (!b.detect && p > 0.85) S.expr = 'nod';
    },
    alarm(S, b, p) {
      S.pose = 'alarm'; S.face = 1; S.expr = 'alarm'; S.mark = '!'; S.flaw = 1;
    },
    remove(S, b, p) {
      S.pose = 'place'; S.face = 1; S.expr = 'focus';
      S.pieces[b.c] = { mode: 'removing', p };
      S.flaw = 1 - p;
      S.placed = null; S.held = b.c;
      if (p >= 1) S.pieces[b.c] = { mode: 'toHand', p: 1, from: 'open' };
    },
    putback(S, b, p) {
      S.pose = 'reach'; S.face = 1; S.expr = 'meh';
      S.pieces[b.c] = { mode: 'dropping', p };
      S.crates[b.c].lid = p < 0.6 ? 1 : 1 - ease((p - 0.6) / 0.4);
      if (p >= 1) { S.held = null; S.pieces[b.c] = { mode: 'crate' }; }
      S.crates[b.c].mark = 'no';
    },
    polish(S, b, p) {
      S.pose = 'polish'; S.face = 1; S.expr = 'happy';
      S.sparkle = p;
    },
    // turns to the user and waits for a go-ahead it didn't need
    checkin(S, b, p) {
      S.pose = S.held !== null ? 'carry' : 'idle'; S.face = -1; S.expr = 'curious';
      S.speech = { p };
    },
    // adds something to the picture nobody asked for
    // pulls out something new, carries it up and sticks it into the finished picture
    extra(S, b, p) {
      S.pose = p < 0.3 ? 'carry' : p < 0.75 ? 'place' : 'proud'; S.face = 1; S.expr = 'happy';
      S.added[b.k] = p;
      if (p >= 0.5) S.extras = b.k + 1;
    },
    done(S, b, p) {
      S.pose = 'celebrate'; S.expr = 'happy'; S.jump = p;
    },
    stamp(S, b, p) {
      S.stamp = { ok: b.ok, p };
      const sad = !b.ok && p > 0.35;
      S.pose = sad ? 'oops' : 'proud';
      S.expr = sad ? 'oops' : 'happy';
    },
  };

  function stateAt(plan, t) {
    const S = freshState();
    let fixes = 0;
    for (const b of plan.beats) {
      if (t < b.t0) break;
      const p = b.dur > 0 ? clamp((t - b.t0) / b.dur, 0, 1) : 1;
      // transient visuals belong to the current beat only
      S.pose = 'idle'; S.expr = 'neutral'; S.bubble = null; S.mag = false; S.scan = null; S.mark = null; S.jump = 0; S.speech = null;
      if (b.type !== 'check' && b.type !== 'alarm' && b.type !== 'remove') S.flaw = 0;
      APPLY[b.type](S, b, p);
      if (b.type === 'remove') fixes++;
      S.phase = b.phase;
      S.beat = b.type;
    }
    S.fixes = fixes;
    S.finished = t >= plan.total;
    return S;
  }

  // ---------------------------------------------------------------------------
  // Scene: builds the SVG once, then moves things around every frame.
  // ---------------------------------------------------------------------------
  function el(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  const set = (e, attrs) => { for (const k in attrs) e.setAttribute(k, attrs[k]); };
  const show = (e, on) => { e.style.display = on ? '' : 'none'; };

  function makePiece(parent) {
    const g = el('g', null, parent);
    const inner = el('g', { 'clip-path': 'url(#pc)' }, g);
    const use = el('use', { x: -HOLE_X, y: -HOLE_Y }, inner);
    const edge = el('path', { d: PIECE, class: 'piece-edge' }, g);
    return { g, use, edge };
  }

  class Scene {
    constructor(svg, seed) {
      this.svg = svg;
      this.seed = seed || 0;
      svg.setAttribute('viewBox', '16 18 968 210');
      const root = el('g', null, svg);

      // backdrop + ground
      el('rect', { x: 0, y: 0, width: 1000, height: GROUND, fill: 'url(#gStage)' }, root);
      el('rect', { x: 0, y: GROUND, width: 1000, height: 40, class: 's-ground' }, root);
      el('line', { x1: 0, x2: 1000, y1: GROUND, y2: GROUND, class: 's-ground-edge' }, root);
      el('ellipse', { cx: START_X, cy: GROUND + 4, rx: 32, ry: 5, class: 's-pad' }, root);

      // easel + picture with a hole in it
      el('line', { x1: FX + FW / 2, y1: FY + FH, x2: FX + FW / 2 + 18, y2: GROUND, class: 's-leg' }, root);
      el('line', { x1: FX + 26, y1: FY + FH, x2: FX + 10, y2: GROUND, class: 's-leg' }, root);
      el('line', { x1: FX + FW - 26, y1: FY + FH, x2: FX + FW - 10, y2: GROUND, class: 's-leg' }, root);
      el('rect', { x: FX - 9, y: FY - 9, width: FW + 18, height: FH + 18, rx: 5, class: 's-frame' }, root);
      const pic = el('g', { transform: `translate(${FX},${FY})` }, root);
      el('use', { href: '#pic0', 'clip-path': 'url(#fc)' }, pic);
      el('path', { d: PIECE, transform: `translate(${HOLE_X},${HOLE_Y})`, class: 's-hole' }, pic);

      // crates
      this.crates = CX.map(cx => {
        const g = el('g', { transform: `translate(${cx - 26},${GROUND - 40})` }, root);
        const inside = el('rect', { x: 2, y: -3, width: 48, height: 6, rx: 2, class: 's-crate-in' }, g);
        el('rect', { width: 52, height: 40, rx: 4, class: 's-crate' }, g);
        el('rect', { y: 13, width: 52, height: 4, class: 's-crate-band' }, g);
        el('rect', { y: 27, width: 52, height: 4, class: 's-crate-band' }, g);
        const lid = el('rect', { x: -2, y: -6, width: 56, height: 8, rx: 3, class: 's-crate-lid' }, g);
        const q = el('text', { x: 26, y: 27, class: 's-q' }, g);
        q.textContent = '?';
        const mark = el('g', { transform: 'translate(26,21)' }, g);
        const markBg = el('circle', { r: 10 }, mark);
        const markGlyph = el('path', { class: 'stamp-glyph', 'stroke-width': 3 }, mark);
        return { g, inside, lid, q, mark, markBg, markGlyph, state: null };
      });

      // the five pieces (what is in each crate is set per task)
      const piecesLayer = el('g', null, root);

      // scan beam sits behind the agent
      this.beam = el('polygon', { class: 'scan-beam' }, root);
      this.scanLine = el('line', { class: 'scan-line' }, root);
      this.flaw = el('circle', { cx: HOLE_CX, cy: HOLE_CY, r: 30, class: 'flaw' }, root);

      // agent
      this.agent = this.buildAgent(root);
      this.pieces = CX.map(() => makePiece(piecesLayer));
      root.appendChild(piecesLayer); // pieces render above the agent (held in front of it)

      // thought bubble
      this.bubble = this.buildBubble(root);

      // marks, stamp, sparkles
      this.mark = el('text', { class: 's-mark' }, root);
      this.sparkles = [[FX + 6, FY + 4, 1], [FX + FW - 10, FY + FH - 6, .8], [FX + FW * .55, FY - 12, .7], [FX - 14, FY + FH * .55, .6]].map(([x, y, s]) =>
        el('path', { d: 'M0,-9 L2.2,-2.2 L9,0 L2.2,2.2 L0,9 L-2.2,2.2 L-9,0 L-2.2,-2.2Z', class: 'sparkle', 'data-x': x, 'data-y': y, 'data-s': s }, root));
      // unrequested additions: new things drawn into the picture, outlined as "not asked for"
      this.added = EXTRAS.map(x => {
        const g = el('g', null, root);
        const ring = el('rect', { x: x.box[0], y: x.box[1], width: x.box[2], height: x.box[3], rx: 5, class: 'x-ring' }, g);
        const art = el('g', { class: 'x-art' }, g);
        art.innerHTML = x.svg;
        return { g, ring, x: FX + x.at[0], y: FY + x.at[1] };
      });

      // check-in: the agent asks, the user answers
      this.speech = el('g', null, root);
      el('path', { d: 'M78,74 L96,74 L100,90 Z', class: 'sp-bubble' }, this.speech);
      el('rect', { x: 0, y: 36, width: 112, height: 40, rx: 14, class: 'sp-bubble' }, this.speech);
      el('rect', { x: 76, y: 70, width: 22, height: 8, class: 'sp-patch' }, this.speech);
      el('text', { x: 56, y: 62, class: 'sp-text' }, this.speech).textContent = 'Shall I?';
      this.reply = el('g', null, root);
      el('rect', { x: 26, y: 112, width: 112, height: 34, rx: 12, class: 'sp-reply' }, this.reply);
      const rt = el('text', { x: 82, y: 134, class: 'sp-text sp-reply-text' }, this.reply);
      rt.textContent = 'Yes, go on';

      this.stamp = el('g', null, root);
      this.stampBg = el('circle', { r: 21 }, this.stamp);
      this.stampGlyph = el('path', { class: 'stamp-glyph' }, this.stamp);
    }

    buildAgent(root) {
      const g = el('g', null, root);
      const shadow = el('ellipse', { cx: 0, cy: 1, rx: 22, ry: 4.5, class: 'a-shadow' }, g);
      const flip = el('g', null, g);
      const bob = el('g', null, flip);
      const legB = el('rect', { x: -3.5, y: 0, width: 7, height: 17, rx: 3.5, class: 'a-leg' }, bob);
      const armB = el('line', { class: 'a-limb' }, bob);
      const legF = el('rect', { x: -3.5, y: 0, width: 7, height: 17, rx: 3.5, class: 'a-leg' }, bob);
      el('line', { x1: 0, y1: -62, x2: 0, y2: -75, class: 'a-antenna' }, bob);
      const halo = el('circle', { cx: 0, cy: -78, r: 8, class: 'a-halo' }, bob);
      el('circle', { cx: 0, cy: -78, r: 3.8, class: 'a-bulb' }, bob);
      el('rect', { x: -20, y: -64, width: 40, height: 50, rx: 17, class: 'a-body' }, bob);
      el('rect', { x: -12, y: -57, width: 30, height: 21, rx: 9, class: 'a-face' }, bob);
      const chest = el('circle', { cx: 4, cy: -26, r: 3.4 }, bob);
      const eyes = el('g', null, bob);
      const eyeL = el('rect', { class: 'a-eye' }, eyes);
      const eyeR = el('rect', { class: 'a-eye' }, eyes);
      const happy = el('path', { d: 'M-4,-45 Q-1,-50 2,-45 M7,-45 Q10,-50 13,-45', class: 'a-eyeline' }, bob);
      const oops = el('path', { d: 'M-4,-47 L2,-45 M7,-45 L13,-47', class: 'a-eyeline' }, bob);
      const mouth = el('path', { d: 'M1,-41 Q4.5,-38 8,-41', class: 'a-eyeline', 'stroke-width': 2 }, bob);
      const sweat = el('path', { d: 'M22,-60 q3,5 0,7 q-3,-2 0,-7Z', class: 'a-sweat' }, bob);
      const armF = el('line', { class: 'a-limb' }, bob);
      const handle = el('line', { class: 'a-handle' }, bob);
      const glass = el('circle', { r: 7.5, class: 'a-glass' }, bob);
      return { g, shadow, flip, bob, legB, legF, armB, armF, halo, chest, eyeL, eyeR, happy, oops, mouth, sweat, handle, glass };
    }

    buildBubble(root) {
      const g = el('g', null, root);
      const inner = el('g', null, g);
      const d1 = el('circle', { cx: 16, cy: 112, r: 3, class: 'b-dot' }, inner);
      const d2 = el('circle', { cx: 25, cy: 98, r: 5, class: 'b-dot' }, inner);
      const cloud = el('rect', { x: 22, y: 34, height: 50, rx: 24, class: 'b-cloud' }, inner);
      const bang = el('text', { x: 0, y: 68, class: 'b-bang' }, inner);
      bang.textContent = '!';
      const sketches = [0, 1, 2, 3].map(() => el('path', { d: PIECE, class: 'b-sketch', pathLength: 1, 'stroke-dasharray': 1 }, inner));
      const tiles = [0, 1, 2, 3, 4].map(() => el('rect', { width: 12, height: 12, rx: 3 }, inner));
      return { g, inner, cloud, bang, sketches, tiles };
    }

    setPlan(plan) {
      this.plan = plan;
      plan.m.forEach((v, i) => this.pieces[i].use.setAttribute('href', '#pic' + v));
      const L = plan.level;
      set(this.agent.halo, { r: 5 + L.idx * 1.5 });
      this.glowBase = 0.16 + L.idx * 0.08;
    }

    render(t) {
      const S = stateAt(this.plan, t);
      this.drawCrates(S);
      this.drawPieces(S);
      this.drawAgent(S, t);
      this.drawBubble(S);
      this.drawEffects(S, t);
      return S;
    }

    drawCrates(S) {
      S.crates.forEach((c, i) => {
        const v = this.crates[i];
        set(v.lid, { transform: `rotate(${(c.lid * 118).toFixed(1)} 54 -2)` });
        v.inside.style.opacity = c.lid.toFixed(2);
        const key = c.mark || '';
        if (v.state !== key) {
          v.state = key;
          show(v.q, !c.mark);
          show(v.mark, !!c.mark);
          if (c.mark) {
            v.markBg.setAttribute('class', c.mark === 'ok' ? 'stamp-ok' : 'stamp-bad');
            v.markGlyph.setAttribute('d', c.mark === 'ok' ? 'M-4.5,0 L-1.2,3.5 L5,-3.5' : 'M-3.8,-3.8 L3.8,3.8 M3.8,-3.8 L-3.8,3.8');
          }
        }
      });
    }

    piecePose(i, pc, S) {
      const cx = CX[i];
      const inCrate = { x: cx, y: GROUND - 34, s: 0.5, o: 0, r: 0 };
      const lifted = { x: cx, y: GROUND - 66, s: 0.74, o: 1, r: 0 };
      const held = { x: S.ax + 33 * S.face, y: GROUND - 44, s: 0.6, o: 1, r: 0 };
      const hole = { x: HOLE_CX, y: HOLE_CY, s: 1, o: 1, r: this.plan.m[i] === 2 ? 7 : 0 };
      const mix = (a, b, p, arc) => {
        const k = ease(p);
        return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k) - (arc || 0) * Math.sin(Math.PI * k),
          s: lerp(a.s, b.s, k), o: lerp(a.o, b.o, Math.min(1, p * 3)), r: lerp(a.r, b.r, k) };
      };
      switch (pc.mode) {
        case 'rising': return mix(inCrate, lifted, pc.p);
        case 'lifted': return lifted;
        case 'sinking': return { ...mix(lifted, inCrate, pc.p), o: 1 - Math.max(0, pc.p - 0.6) / 0.4 };
        case 'toHand': {
          const from = pc.from === 'lifted' ? lifted : { ...inCrate, y: GROUND - 44 };
          return mix(from, held, pc.p, 10);
        }
        case 'placing': return mix(held, hole, pc.p, 18);
        case 'placed': return hole;
        case 'removing': return mix(hole, held, pc.p, 12);
        case 'dropping': return { ...mix(held, inCrate, pc.p, 16), o: 1 - Math.max(0, pc.p - 0.7) / 0.3 };
        default: return inCrate;
      }
    }

    drawPieces(S) {
      S.pieces.forEach((pc, i) => {
        const v = this.pieces[i];
        const P = this.piecePose(i, pc, S);
        if (P.o <= 0.01) { show(v.g, false); return; }
        show(v.g, true);
        v.g.style.opacity = P.o.toFixed(2);
        set(v.g, { transform: `translate(${P.x.toFixed(1)},${P.y.toFixed(1)}) rotate(${P.r.toFixed(1)}) scale(${P.s.toFixed(3)}) translate(-17,-17)` });
        const wrong = S.stamp && !S.stamp.ok && S.stamp.p > 0.3 && pc.mode === 'placed';
        v.edge.setAttribute('class', wrong ? 'piece-edge wrong' : 'piece-edge');
      });
    }

    drawAgent(S, t) {
      const A = this.agent;
      const sw = Math.sin(S.walk / 9);
      const walking = S.pose === 'walk' || S.pose === 'carryWalk';
      let bob = walking ? -Math.abs(sw) * 2.6 : Math.sin(t * 2.2 + this.seed) * 0.7;
      if (S.pose === 'celebrate') bob = -Math.abs(Math.sin(S.jump * Math.PI * 2)) * 15;
      set(A.g, { transform: `translate(${S.ax.toFixed(1)},${GROUND})` });
      set(A.flip, { transform: `scale(${S.face},1)` });
      set(A.bob, { transform: `translate(0,${bob.toFixed(2)})` });
      set(A.shadow, { rx: (22 + bob * 0.6).toFixed(1) });

      const leg = walking ? sw * 26 : 0;
      set(A.legB, { transform: `translate(-8,-17) rotate(${(-leg).toFixed(1)} 0 0)` });
      set(A.legF, { transform: `translate(8,-17) rotate(${leg.toFixed(1)} 0 0)` });

      const [ab, af, lb, lf] = this.arms(S, t, sw);
      const arm = (line, sx, deg, len) => {
        const a = deg * Math.PI / 180;
        const hx = sx + Math.sin(a) * len, hy = -42 + Math.cos(a) * len;
        set(line, { x1: sx, y1: -42, x2: hx.toFixed(1), y2: hy.toFixed(1) });
        return [hx, hy, Math.sin(a), Math.cos(a)];
      };
      arm(A.armB, -15, ab, lb);
      const [hx, hy, dx, dy] = arm(A.armF, 15, af, lf);
      show(A.glass, S.mag); show(A.handle, S.mag);
      if (S.mag) {
        set(A.handle, { x1: hx.toFixed(1), y1: hy.toFixed(1), x2: (hx + dx * 4).toFixed(1), y2: (hy + dy * 4).toFixed(1) });
        set(A.glass, { cx: (hx + dx * 11).toFixed(1), cy: (hy + dy * 11).toFixed(1) });
        this.glassAbs = { x: S.ax + (hx + dx * 11) * S.face, y: GROUND + bob + hy + dy * 11 };
      }

      // antenna glow: brighter for more effort, pulsing while thinking
      const pulse = S.pose === 'think' ? 0.5 + 0.5 * Math.sin(t * 9) : 0;
      A.halo.style.opacity = Math.min(0.75, this.glowBase * (1 + pulse * 0.9)).toFixed(2);
      A.chest.style.fill = `var(--${S.phase})`;

      // eyes
      const blink = ((t + this.seed * 1.7) % 3.6) < 0.12 && !['happy', 'oops'].includes(S.expr);
      const E = {
        neutral: [5, 9, 0, 0], curious: [5.5, 10, 2, -1.5], think: [5, 8, 2, -3], focus: [6, 5, 1.5, 0],
        nod: [5.5, 7, 1, 0], meh: [6, 3.5, 0, 1], alarm: [7.5, 12, 0, -1],
      }[S.expr];
      const eyesOn = !!E;
      show(A.eyeL, eyesOn); show(A.eyeR, eyesOn);
      show(A.happy, S.expr === 'happy');
      show(A.oops, S.expr === 'oops');
      show(A.sweat, S.expr === 'oops' || S.expr === 'alarm');
      show(A.mouth, S.expr === 'happy' || S.expr === 'nod');
      if (eyesOn) {
        const [w, h0, ox, oy] = E;
        const h = blink ? 1.4 : h0;
        [[-1, A.eyeL], [10, A.eyeR]].forEach(([cx, e]) =>
          set(e, { x: (cx - w / 2 + ox).toFixed(1), y: (-47 - h / 2 + oy).toFixed(1), width: w, height: h.toFixed(1), rx: Math.min(w, h) / 2 }));
      }
    }

    arms(S, t, sw) {
      switch (S.pose) {
        case 'walk': return [-sw * 30, sw * 30, 17, 17];
        case 'carry': case 'carryWalk': return [72, 96, 17, 18];
        case 'think': return [-12, 152, 17, 14];
        case 'reach': return [-10, 62, 17, 24];
        case 'inspect': return [-14, 116, 17, 20];
        case 'place': return [132, 138, 20, 24];
        case 'check': return [-22, 118, 17, 22];
        case 'alarm': return [158, 162, 19, 19];
        case 'celebrate': { const j = Math.sin(t * 16) * 12; return [160 + j, 160 - j, 19, 19]; }
        case 'proud': return [-24, 24, 13, 13];
        case 'oops': return [-10, 168, 17, 16];
        case 'polish': return [-14, 112 + Math.sin(t * 18) * 24, 17, 25];
        default: { const br = Math.sin(t * 2.2 + this.seed) * 3; return [-10 + br, 10 - br, 17, 17]; }
      }
    }

    drawBubble(S) {
      const B = this.bubble, bub = S.bubble;
      show(B.g, !!bub);
      if (!bub) return;
      const intro = clamp(bub.p / 0.1, 0, 1), outro = clamp((1 - bub.p) / 0.07, 0, 1);
      const sc = backOut(Math.min(intro, 1)) * Math.min(1, outro * 1.2 + 0.2 * (outro > 0));
      set(B.g, { transform: `translate(${S.ax.toFixed(1)},0)` });
      set(B.inner, { transform: `translate(16,112) scale(${Math.max(0.001, sc).toFixed(3)}) translate(-16,-112)` });
      B.inner.style.opacity = Math.min(1, outro * 1.5).toFixed(2);

      const isPlan = bub.kind === 'plan';
      const n = isPlan ? bub.n : 0;
      const w = isPlan ? (n === 0 ? 46 : 26 + n * 36) : 26 + 5 * 18;
      set(B.cloud, { width: w });
      show(B.bang, isPlan && n === 0);
      set(B.bang, { x: 22 + w / 2 });
      B.sketches.forEach((s, k) => {
        const on = isPlan && k < n;
        show(s, on);
        if (!on) return;
        const span = 0.8 / n, start = 0.1 + k * span;
        const lp = clamp((bub.p - start) / span, 0, 1);
        set(s, { transform: `translate(${22 + 15 + k * 36},49) scale(.62)`, 'stroke-dashoffset': (1 - lp).toFixed(3) });
        const best = n > 1 && k === n - 1 && bub.p > 0.9;
        s.style.fill = best ? 'var(--think)' : 'none';
        s.style.fillOpacity = best ? '0.3' : '0';
      });
      B.tiles.forEach((r, k) => {
        const on = !isPlan;
        show(r, on);
        if (!on) return;
        const lp = clamp((bub.p - 0.08 - k * 0.08) / 0.08, 0, 1);
        const good = bub.marks[k];
        const pulse = good && bub.p > 0.7 ? 1 + 0.25 * Math.sin(bub.p * 40) : 1;
        set(r, { x: 22 + 13 + k * 18, y: 53 });
        r.style.fill = good ? 'var(--check)' : 'var(--bad)';
        r.style.opacity = (lp * (good ? 1 : 0.45)).toFixed(2);
        r.style.transformBox = 'fill-box';
        r.style.transformOrigin = 'center';
        r.style.transform = `scale(${pulse.toFixed(2)})`;
      });
    }

    drawEffects(S, t) {
      // ? / ! above the head
      show(this.mark, !!S.mark);
      if (S.mark) {
        this.mark.textContent = S.mark;
        set(this.mark, { x: S.ax.toFixed(1), y: GROUND - 92 - Math.sin(t * 6) * 2 });
        this.mark.style.fill = S.mark === '!' ? 'var(--bad)' : 'var(--muted)';
      }

      // unrequested additions: appear in the hand, arc into the picture, then get outlined
      this.added.forEach((a, k) => {
        const p = S.added[k];
        show(a.g, p > 0);
        if (!(p > 0)) return;
        const hand = { x: S.ax + 30 * S.face, y: GROUND - 50 };
        let x, y, sc;
        if (p < 0.3) { x = hand.x; y = hand.y; sc = 1.3 * backOut(clamp(p / 0.25, 0, 1)); }
        else {
          const k2 = ease(clamp((p - 0.3) / 0.42, 0, 1));
          x = lerp(hand.x, a.x, k2); y = lerp(hand.y, a.y, k2) - 40 * Math.sin(Math.PI * k2); sc = lerp(1.3, 1, k2);
        }
        set(a.g, { transform: `translate(${x.toFixed(1)},${y.toFixed(1)}) scale(${Math.max(0.001, sc).toFixed(3)})` });
        const rp = clamp((p - 0.72) / 0.2, 0, 1);
        show(a.ring, rp > 0);
        if (rp > 0) {
          const pulse = p < 1 ? 1 + 0.25 * Math.sin(rp * Math.PI) : 1;
          a.ring.style.opacity = (p < 1 ? rp : 0.85).toFixed(2);
          a.ring.style.transformBox = 'fill-box'; a.ring.style.transformOrigin = 'center';
          a.ring.style.transform = `scale(${pulse.toFixed(2)})`;
        }
      });

      // check-in: a speech bubble, then (after a wait) the user's reply
      const sp = S.speech;
      show(this.speech, !!sp); show(this.reply, !!sp && sp.p > 0.62);
      if (sp) {
        const pop = Math.max(0.001, backOut(clamp(sp.p / 0.1, 0, 1)));
        const bx = S.ax - 108;
        set(this.speech, { transform: `translate(${bx.toFixed(1)},0) translate(100,90) scale(${pop.toFixed(3)}) translate(-100,-90)` });
        this.speech.style.opacity = sp.p < 0.62 ? '1' : (1 - (sp.p - 0.62) / 0.38 * 0.5).toFixed(2);
        const rp = Math.max(0.001, backOut(clamp((sp.p - 0.62) / 0.12, 0, 1)));
        set(this.reply, { transform: `translate(26,129) scale(${rp.toFixed(3)}) translate(-26,-129)` });
      }

      // checking: a beam from the magnifier sweeping across the picture
      const sc = S.scan;
      show(this.beam, !!sc); show(this.scanLine, !!sc);
      if (sc && this.glassAbs) {
        const glance = sc.depth === 'glance';
        const k = glance ? clamp(sc.p * 1.15, 0, 1) : ease(sc.p);
        const x = FX + 4 + k * (FW - 8);
        const top = glance ? FY + 22 : FY + 2, bot = glance ? FY + FH - 22 : FY + FH - 2;
        const g = this.glassAbs;
        set(this.beam, { points: `${g.x.toFixed(1)},${g.y.toFixed(1)} ${x.toFixed(1)},${top} ${x.toFixed(1)},${bot}` });
        set(this.scanLine, { x1: x.toFixed(1), x2: x.toFixed(1), y1: top, y2: bot });
        this.scanLine.style.opacity = glance ? '0.55' : '1';
        this.scanLine.style.strokeDasharray = glance ? '4 5' : 'none';
      }

      // a found flaw throbs red around the piece
      show(this.flaw, S.flaw > 0.01);
      if (S.flaw > 0.01) {
        this.flaw.style.opacity = (S.flaw * (0.65 + 0.35 * Math.sin(t * 14))).toFixed(2);
        set(this.flaw, { r: (28 + 4 * Math.sin(t * 14)).toFixed(1) });
      }

      // polish sparkles (max only)
      this.sparkles.forEach((s, k) => {
        const local = clamp((S.sparkle - k * 0.18) / 0.4, 0, 1);
        const v = S.finished || S.beat === 'done' || S.beat === 'stamp' ? (S.sparkle > 0 ? 0.65 + 0.35 * Math.sin(t * 3 + k * 1.7) : 0) : Math.sin(Math.PI * local);
        show(s, v > 0.02);
        const x = +s.dataset.x, y = +s.dataset.y, base = +s.dataset.s;
        set(s, { transform: `translate(${x},${y}) scale(${(base * v).toFixed(3)}) rotate(${(t * 40 + k * 20) % 360})` });
      });

      // the verdict
      show(this.stamp, !!S.stamp);
      if (S.stamp) {
        const p = clamp((S.stamp.p - 0.15) / 0.5, 0, 1);
        const s = Math.max(0.001, backOut(p));
        set(this.stamp, { transform: `translate(${FX + FW - 2},${FY + 10}) scale(${s.toFixed(3)}) rotate(${((1 - p) * -25).toFixed(1)})` });
        this.stampBg.setAttribute('class', S.stamp.ok ? 'stamp-ok' : 'stamp-bad');
        this.stampGlyph.setAttribute('d', S.stamp.ok ? 'M-9,0 L-3,6.5 L9.5,-6.5' : 'M-7.5,-7.5 L7.5,7.5 M7.5,-7.5 L-7.5,7.5');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Timeline strips: the same plan, drawn as coloured time.
  // ---------------------------------------------------------------------------
  function buildStrip(host, plan, scale) {
    host.textContent = '';
    const track = document.createElement('div'); track.className = 'track';
    const lit = document.createElement('div'); lit.className = 'lit';
    for (const layer of [track, lit]) {
      for (const s of plan.segs) {
        const d = document.createElement('div');
        d.className = 'seg-p';
        d.style.left = (s.t0 / scale * 100) + '%';
        d.style.width = (s.dur / scale * 100 + 0.05) + '%';
        d.style.background = `var(--${s.phase})`;
        layer.appendChild(d);
      }
    }
    const head = document.createElement('div'); head.className = 'head';
    host.append(track, lit, head);
    const strip = {
      update(t) {
        const f = clamp(Math.min(t, plan.total) / scale, 0, 1);
        lit.style.clipPath = `inset(0 ${(100 - f * 100).toFixed(2)}% 0 0)`;
        head.style.left = (f * 100).toFixed(2) + '%';
      },
    };
    strip.update(0);
    return strip;
  }

  // ---------------------------------------------------------------------------
  // Little HTML icons for counters
  // ---------------------------------------------------------------------------
  const ICON = {
    look: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="var(--look)" stroke-width="2.4"/><path d="M12.7 12.7 17 17" stroke="var(--look)" stroke-width="2.6" stroke-linecap="round"/></svg>',
    check: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" fill="none" stroke="var(--check)" stroke-width="2.4"/><path d="M6 10.2 8.8 13 14 7.5" fill="none" stroke="var(--check)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    fix: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M15.5 6.5A6.5 6.5 0 1 0 16.4 12" fill="none" stroke="var(--do)" stroke-width="2.4" stroke-linecap="round"/><path d="M16.5 2.5v4.6h-4.6" fill="none" stroke="var(--do)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    extra: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="1.5" y="1.5" width="17" height="17" rx="4" fill="none" stroke="var(--extra)" stroke-width="2" stroke-dasharray="3 2.2"/><path d="M5.5 10 10 5.5 14.5 10M7 9.5V14.5H13V9.5" fill="none" stroke="var(--extra)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>',
    think: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2" y="3" width="16" height="10" rx="5" fill="none" stroke="var(--think)" stroke-width="2.2"/><circle cx="5" cy="16.5" r="1.8" fill="var(--think)"/></svg>',
    ok: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 10.5 8.3 14 15.5 6.5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    bad: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 5.5l9 9M14.5 5.5l-9 9" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/></svg>',
  };
  document.querySelectorAll('[data-extra-icon]').forEach(e => { e.innerHTML = ICON.extra; });
  const meterHTML = idx => '<span class="meter" aria-hidden="true">' +
    [0, 1, 2, 3, 4].map(i => `<b class="${i <= idx ? 'on' : ''}"></b>`).join('') + '</span>';

  // ---------------------------------------------------------------------------
  // App state + wiring
  // ---------------------------------------------------------------------------
  const app = { model: 'opus-5.5', task: 'tricky', level: MODELS['opus-5.5'].def, speed: 1 };
  const plansFor = task => LEVELS.map(L => buildPlan(L, task, app.model));
  const isDefault = i => MODELS[app.model].def === i;
  const DEF_TAG = '<span class="def-tag">default</span>';

  function blurbFor(plan) {
    let s = plan.level.blurb;
    if (plan.checkIn) s += ' Then stops to ask before it finishes.';
    if (plan.extras) s += plan.extras === 1 ? ' Adds something you didn’t ask for.' : ` Adds ${plan.extras} things you didn’t ask for.`;
    return s;
  }
  const scaleFor = plans => Math.max(...plans.map(p => p.total));

  function radioGroup(host, items, current, onPick, render) {
    host.textContent = '';
    const buttons = items.map(it => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.value = it.value;
      b.innerHTML = render ? render(it) : it.label;
      b.addEventListener('click', () => onPick(it.value));
      host.appendChild(b);
      return b;
    });
    host.addEventListener('keydown', e => {
      const i = buttons.indexOf(document.activeElement);
      if (i < 0) return;
      const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const n = buttons[(i + d + buttons.length) % buttons.length];
      n.focus(); n.click();
    });
    const sync = v => buttons.forEach(b => {
      const on = b.dataset.value === String(v);
      b.setAttribute('aria-checked', on);
      b.tabIndex = on ? 0 : -1;
    });
    sync(current);
    return sync;
  }

  // ---- race ----
  const lanesHost = document.getElementById('lanes');
  const lanes = LEVELS.map((L, i) => {
    const li = document.createElement('li');
    li.className = 'lane';
    li.innerHTML = `
      <div class="lane-label"><span class="lvl">${L.id}</span>${meterHTML(i)}${DEF_TAG}</div>
      <div class="lane-main"><svg class="scene" role="img" aria-label="${L.id} effort"></svg><div class="strip"></div></div>
      <div class="lane-hud">
        <div class="stats"><span title="Crates looked in">${ICON.look}<em>0</em></span><span title="Checks">${ICON.check}<em>0</em></span><span title="Extras nobody asked for">${ICON.extra}<em>0</em></span></div>
        <div class="result" aria-live="polite"></div>
      </div>`;
    lanesHost.appendChild(li);
    const scene = new Scene(li.querySelector('svg'), i * 1.3);
    const [looked, checks, extras] = li.querySelectorAll('.stats em');
    return { L, li, scene, stripHost: li.querySelector('.strip'), looked, checks, extras, result: li.querySelector('.result'), plan: null, strip: null };
  });

  const race = { t: 0, playing: false, started: false, end: 0, visible: false };

  function setupRace() {
    const plans = plansFor(app.task);
    const scale = scaleFor(plans);
    lanes.forEach((ln, i) => {
      ln.li.classList.toggle('is-default', isDefault(i));
      ln.plan = plans[i];
      ln.scene.setPlan(plans[i]);
      ln.strip = buildStrip(ln.stripHost, plans[i], scale);
      ln.resultKey = null;
    });
    race.end = scale + 1.2;
    race.t = 0;
    renderRace();
  }
  function renderRace() {
    lanes.forEach(ln => {
      const S = ln.scene.render(race.t);
      ln.strip.update(race.t);
      ln.looked.textContent = S.looked;
      ln.checks.textContent = S.checks;
      ln.extras.textContent = S.extras;
      const key = S.stamp && S.stamp.p > 0.3 ? (S.stamp.ok ? 'ok' : 'bad') : '';
      if (key !== ln.resultKey) {
        ln.resultKey = key;
        ln.result.className = 'result' + (key ? ' ' + key : '');
        ln.result.innerHTML = key ? ICON[key] : '';
        ln.result.setAttribute('aria-label', key === 'ok' ? 'Right piece' : key === 'bad' ? 'Wrong piece' : '');
      }
    });
  }

  // ---- close-up ----
  const stage = new Scene(document.getElementById('stage-svg'), 0.4);
  const closeStripHost = document.getElementById('close-strip');
  const hud = document.getElementById('close-hud');
  const blurb = document.getElementById('blurb');
  const playBtn = document.getElementById('close-play');
  const close = { t: 0, playing: false, plan: null, strip: null, end: 0, visible: false, started: false };
  hud.innerHTML = `<span title="Thinking">${ICON.think}<em>0.0s</em></span><span title="Crates looked in">${ICON.look}<em>0</em></span><span title="Checks">${ICON.check}<em>0</em></span><span title="Fixes">${ICON.fix}<em>0</em></span><span title="Extras nobody asked for">${ICON.extra}<em>0</em></span>`;
  const [hThink, hLook, hCheck, hFix, hExtra] = hud.querySelectorAll('em');

  function setupClose() {
    const plans = plansFor(app.task);
    close.plan = plans[app.level];
    stage.setPlan(close.plan);
    close.strip = buildStrip(closeStripHost, close.plan, scaleFor(plans));
    close.end = close.plan.total + 0.6;
    close.t = 0;
    blurb.textContent = blurbFor(close.plan);
    renderClose();
  }
  function renderClose() {
    const S = stage.render(close.t);
    close.strip.update(close.t);
    hThink.textContent = (S.thought / TEMPO).toFixed(1) + 's';
    hLook.textContent = S.looked;
    hCheck.textContent = S.checks;
    hFix.textContent = S.fixes;
    hExtra.textContent = S.extras;
    playBtn.textContent = close.playing ? 'Pause' : 'Play';
  }

  // scrubbing on the big strip
  let scrubbing = false;
  const scrubTo = e => {
    const r = closeStripHost.getBoundingClientRect();
    const plans = plansFor(app.task);
    close.t = clamp((e.clientX - r.left) / r.width, 0, 1) * scaleFor(plans);
    close.t = Math.min(close.t, close.plan.total);
    renderClose();
  };
  closeStripHost.addEventListener('pointerdown', e => {
    scrubbing = true; close.playing = false; closeStripHost.setPointerCapture(e.pointerId); scrubTo(e);
  });
  closeStripHost.addEventListener('pointermove', e => { if (scrubbing) scrubTo(e); });
  closeStripHost.addEventListener('pointerup', () => { scrubbing = false; });

  playBtn.addEventListener('click', () => {
    if (!close.playing && close.t >= close.plan.total) close.t = 0;
    close.playing = !close.playing;
    renderClose();
  });
  document.getElementById('close-replay').addEventListener('click', () => { close.t = 0; close.playing = true; renderClose(); });
  document.getElementById('race-replay').addEventListener('click', () => { race.t = 0; race.playing = true; renderRace(); });

  // ---- lesson matrix ----
  function buildMatrix() {
    const host = document.getElementById('matrix');
    const all = Object.keys(TASKS).map(k => plansFor(k));
    const scale = Math.max(...all.map(scaleFor));
    host.innerHTML = '<div></div>' + Object.values(TASKS).map(t => `<div class="colh">${t.label}</div>`).join('');
    LEVELS.forEach((L, i) => {
      const rh = document.createElement('div');
      rh.className = 'rowh';
      rh.innerHTML = L.id + (isDefault(i) ? DEF_TAG : '');
      host.appendChild(rh);
      all.forEach(plans => {
        const p = plans[i];
        const best = plans.findIndex(q => q.ok) === i;
        const cell = document.createElement('div');
        cell.className = 'cell' + (best ? ' best' : '');
        const extra = p.extras ? `<span class="xtra" title="Extras nobody asked for">${ICON.extra.repeat(p.extras)}</span>` : '';
        cell.innerHTML = `<div class="strip"></div>${extra}<span class="mark ${p.ok ? 'ok' : 'bad'}">${ICON[p.ok ? 'ok' : 'bad']}</span>`;
        cell.setAttribute('aria-label', `${L.id} on ${TASKS[p.task].label.toLowerCase()} job: ${p.ok ? 'right' : 'wrong'}` +
          `${p.extras ? `, plus ${p.extras} unrequested` : ''}${p.checkIn ? ', stops to ask' : ''}${best ? ', the best pick' : ''}`);
        host.appendChild(cell);
        buildStrip(cell.querySelector('.strip'), p, scale).update(p.total);
      });
    });
  }

  // ---- controls ----
  const taskItems = Object.entries(TASKS).map(([value, t]) => ({ value, label: t.label }));
  const taskSyncs = [];
  const pickTask = v => {
    app.task = v;
    taskSyncs.forEach(s => s(v));
    setupRace(); setupClose();
    race.playing = !reduceMotion && race.visible; race.started = race.playing || race.started;
    close.playing = !reduceMotion && close.visible;
    renderRace(); renderClose();
  };
  document.querySelectorAll('[data-task-toggle]').forEach(h => taskSyncs.push(radioGroup(h, taskItems, app.task, pickTask)));

  const dialHost = document.getElementById('dial');
  const dialSync = radioGroup(dialHost,
    LEVELS.map((L, i) => ({ value: String(i), label: L.id })), String(app.level),
    v => { app.level = +v; dialSync(v); setupClose(); close.playing = true; renderClose(); },
    it => `<span class="lvl">${it.label}</span>${meterHTML(+it.value)}${DEF_TAG}`);
  const syncDefaults = () => dialHost.querySelectorAll('button').forEach((b, i) => b.classList.toggle('is-default', isDefault(i)));

  const modelNote = document.getElementById('model-note');
  const showModel = () => {
    const M = MODELS[app.model];
    modelNote.textContent = M.note;
    document.querySelectorAll('[data-model-name]').forEach(e => { e.textContent = M.label; });
    syncDefaults();
  };
  const modelSync = radioGroup(document.getElementById('model'),
    Object.entries(MODELS).map(([value, M]) => ({ value, label: M.label })), app.model,
    v => {
      app.model = v;
      app.level = MODELS[v].def;
      modelSync(v); dialSync(String(app.level)); showModel();
      setupRace(); setupClose(); buildMatrix();
      race.playing = !reduceMotion && race.visible; race.started = race.playing || race.started;
      close.playing = !reduceMotion && close.visible;
      renderRace(); renderClose();
    });
  showModel();

  const speedSync = radioGroup(document.getElementById('race-speed'),
    [{ value: '1', label: '1×' }, { value: '2', label: '2×' }], '1',
    v => { app.speed = +v; speedSync(v); });

  setupRace();
  setupClose();
  buildMatrix();

  // start each animation when it scrolls into view; pause it when it leaves
  const io = new IntersectionObserver(entries => {
    for (const e of entries) {
      const target = e.target.id === 'lanes' ? race : close;
      target.visible = e.isIntersecting;
      if (e.isIntersecting && !target.started && !reduceMotion) { target.started = true; target.playing = true; }
    }
  }, { threshold: 0.3 });
  io.observe(lanesHost);
  io.observe(document.querySelector('.stage'));

  // for inspecting a single moment from the console
  window.effort = {
    seekRace(t) { race.playing = false; race.t = t; renderRace(); },
    seekClose(t) { close.playing = false; close.t = t; renderClose(); },
    plans: () => lanes.map(l => ({ id: l.L.id, total: +l.plan.total.toFixed(2), ok: l.plan.ok, extras: l.plan.extras, checkIn: l.plan.checkIn })),
    model(id) { document.querySelector(`#model [data-value="${id}"]`).click(); },
  };

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (race.playing && race.visible) {
      race.t += dt * app.speed;
      if (race.t >= race.end) { race.t = race.end; race.playing = false; }
      renderRace();
    }
    if (close.playing && close.visible && !scrubbing) {
      close.t += dt;
      if (close.t >= close.end) { close.t = close.end; close.playing = false; }
      renderClose();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
