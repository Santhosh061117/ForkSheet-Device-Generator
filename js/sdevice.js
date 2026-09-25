/* ==========================================================================
   js/sdevice.js
   --------------------------------------------------------------------------
   Writes a Sentaurus Device command file for whatever structure was loaded.

   The SCM is the source of truth. Every electrode in the generated deck is
   a contact that actually exists in the parsed file, every region named in
   CurrentPlot is a region that actually exists, and the mesh filename comes
   from the file's own sde:build-mesh call. Nothing here is a template with
   the names filled in: load a seven-contact structure and you get seven
   electrodes, load an eight-contact one and you get eight.

   That distinction is not cosmetic. A deck that declares an electrode the
   mesh does not have makes SDevice abort; a deck that silently omits one
   the mesh does have leaves that region floating, which is a physics bug
   that still converges and still produces plausible-looking curves.

   Style follows the reference deck: plain Sentaurus syntax, explicit
   numbers, no macros or intermediate definitions. A command file is read
   and edited by hand far more often than it is generated.

   Loaded as a classic script; exposes window.SDevice.
   ========================================================================== */

'use strict';

(function () {

  /* ==================================================================
     1. ELECTRODE ROLES
     ==================================================================
     Contact names carry their role and their device, but not in one
     fixed convention: source_n, n_source, nSource and SOURCE_N all turn
     up. Matching on the parts rather than on a whole name means an
     unfamiliar file still classifies, and anything genuinely unknown is
     reported as such rather than guessed at.
     ================================================================== */

  function classifyElectrode(name) {
    const s = String(name);
    const low = s.toLowerCase();

    let role = 'other';
    if (/gate/.test(low)) role = 'gate';
    else if (/source/.test(low)) role = 'source';
    else if (/drain/.test(low)) role = 'drain';
    else if (/well|body|tub/.test(low)) role = 'well';
    else if (/sub|bulk|back/.test(low)) role = 'bulk';

    /* device tag: a leading or trailing n/p that is not part of a word */
    let device = null;
    if (/(^|[^a-z])n($|[^a-z])/.test(low) || /_n$|^n_/.test(low)) device = 'n';
    if (/(^|[^a-z])p($|[^a-z])/.test(low) || /_p$|^p_/.test(low)) device = 'p';
    if (/nmos|nfet/.test(low)) device = 'n';
    if (/pmos|pfet/.test(low)) device = 'p';
    if (role === 'well' && /nwell|n_well|welln|well_n/.test(low)) device = 'p'; // an n-well is the pFET body
    if (role === 'bulk') device = null;

    return { name: s, role, device };
  }

  function classifyElectrodes(contacts) {
    return (contacts || []).map((c) => classifyElectrode(c.name));
  }

  /** Group the classified electrodes into the devices they belong to. */
  function devicesOf(elec) {
    const tags = [...new Set(elec.filter((e) => e.device).map((e) => e.device))].sort();
    return tags.map((tag) => ({
      tag,
      gate: elec.find((e) => e.device === tag && e.role === 'gate'),
      source: elec.find((e) => e.device === tag && e.role === 'source'),
      drain: elec.find((e) => e.device === tag && e.role === 'drain'),
      well: elec.find((e) => e.device === tag && e.role === 'well'),
    })).filter((d) => d.gate && d.source && d.drain);
  }


  /* ==================================================================
     2. SETTINGS
     ==================================================================
     Everything the two decks can be told to do. The shape follows the
     decks themselves: one isothermal drift-diffusion run per device, a
     pair of Id-Vg sweeps and a family of Id-Vd sweeps, with the gate
     workfunction as the threshold knob.

     There is no thermal section. These decks are explicitly isothermal -
     no Thermodynamic, no Thermode - so a self-heating control here would
     be a switch wired to nothing.
     ================================================================== */

  function defaultSettings(parsed, analysis) {
    const elec = classifyElectrodes(parsed.contacts);
    const devs = devicesOf(elec);

    /* Gate workfunction is per DEVICE, not per electrode: it is applied to
       every metal region of that gate, which is how a Vt shift is actually
       expressed in a deck. The region names come from the structure. */
    const wf = {};
    for (const d of devs) wf[d.tag] = d.tag === 'p' ? 4.85 : 4.35;

    return {
      stem: parsed.meshPrefix || 'device',
      grid: parsed.meshPrefix ? parsed.meshPrefix + '_msh.tdr' : 'device_msh.tdr',

      /* Which deck to write. The two devices share one mesh but are
         simulated separately, so "both" produces two files. */
      device: 'both',                 // 'n' | 'p' | 'both'

      temperature: 300,
      areaFactor: 1,
      workfunction: wf,

      physics: {
        mobDoping: true,
        mobEnormal: true,
        mobHighField: true,
        srh: true,
        eid: true,                    // EffectiveIntrinsicDensity(OldSlotboom)
      },

      bias: {
        vdd: 0.70,                    // saturation |Vds|, and the |Vg| sweep end
        vdlin: 0.05,                  // linear |Vds|
        vgSteps: [0.30, 0.50, 0.70],  // the Id-Vd family, |Vgs|
        sweepStep: 0.02,              // MaxStep on the measured sweeps
        intervals: 35,                // CurrentPlot points per sweep
        idvgLin: true,
        idvgSat: true,
        idvd: true,
        onStateSnapshot: true,        // Plot(...) at the saturation corner
      },

      math: {
        digits: 5,
        iterations: 40,
        notdamped: 20,
        threads: 4,
        method: 'ParDiSo',
        rhsMin: '1e-12',
        errRef: '1e10',
      },

      plot: {
        carriers: true, current: true, potential: true, doping: true,
        quasiFermi: true, bands: true, mobility: true,
      },

      meshControl: { size: 2.0 },     // nm, for the SCM refinement block
    };
  }


  /* ==================================================================
     3. THE DECK
     ==================================================================
     One file per device. Everything that names something in the
     structure - electrodes, gate regions, the grid file - is read from
     the parsed SCM, so a structure with different names still produces
     a deck that refers to things that exist.
     ================================================================== */

  /** Every metal region belonging to one device's gate, in build order. */
  function gateRegionsOf(regions, tag) {
    return regions
      .filter((r) => /tin|tungsten|metal|poly/i.test(r.material))
      .filter((r) => r.name.startsWith(tag + '_'))
      .map((r) => r.name);
  }

  /** "0p05" / "m0p70" - a voltage as a filename-safe token. */
  function vTag(v) {
    const s = Math.abs(v).toFixed(2).replace('.', 'p');
    return (v < 0 ? 'm' : '') + s;
  }

  function f2(v) { return Number(v).toFixed(2).replace(/\.?0+$/, (m) => m); }

  /** Voltages inside comments are always two decimals: "-0.70 V". */
  function vc(v) { return Number(v).toFixed(2); }

  /** A number the way the decks write it in a Goal: -0.7, 0.05, 0.0 */
  function volts(v) {
    const s = Number(v).toFixed(2);
    return s.replace(/0$/, '').replace(/\.$/, '.0');
  }

  /**
   * The decks, as separate files.
   *
   * The nMOS and pMOS are separate simulations that happen to share a mesh,
   * so they are separate files: each has its own File block naming its own
   * Plot, Current and Output prefixes, and running one has nothing to do
   * with running the other. Concatenating them into one text - which is what
   * this used to do for "both" - produced something that is not a valid
   * command file at all, because SDevice reads exactly one File block.
   *
   * Returns [{ tag, filename, text }], in n-then-p order.
   */
  function buildDecks(parsed, analysis, st) {
    const elec = classifyElectrodes(parsed.contacts);
    const devs = devicesOf(elec);
    const want = st.device === 'both' ? devs : devs.filter((d) => d.tag === st.device);
    return want.map((d) => ({
      tag: d.tag,
      filename: `sdevice_${d.tag}mos.cmd`,
      text: oneDeck(parsed, st, elec, devs, d),
    }));
  }

  /** One string, for callers that want the decks concatenated. */
  function buildSdevice(parsed, analysis, st) {
    const decks = buildDecks(parsed, analysis, st);
    if (!decks.length) {
      return '* No device matching the selection was found in this structure.\n';
    }
    return decks.map((d) => d.text).join('\n');
  }

  function oneDeck(parsed, st, elec, devs, d) {
    const L = [];
    const P = (...xs) => L.push(...xs);
    const T = d.tag;                       // 'n' or 'p'
    const name = T + 'mos';
    const sgn = T === 'p' ? -1 : 1;        // pMOS biases are negative
    const b = st.bias;
    const regions = parsed.regions || [];

    const vdd = sgn * b.vdd;
    const vlin = sgn * b.vdlin;

    /* ---------------- banner ---------------- */
    P('* ' + '='.repeat(74));
    P(`*  sdevice_${name}.cmd  --  3D FORKSHEET CMOS, ${T.toUpperCase()}MOS I-V ONLY`);
    P(`*  Structure: ${st.grid}`);
    P('*');
    P(`*  ${elec.length} electrodes, matching the SCM exactly:`);
    P('*    ' + elec.map((e) => e.name).join(' '));
    if (T === 'p' && !elec.some((e) => e.role === 'wellp')) {
      P('*  There is NO n-well electrode in this structure, so the n-well floats.');
      P('*  Expect the drain current to be dominated by the open-base p+/n/p+');
      P('*  path and to be insensitive to the gate.');
    }
    P('*');
    P(`*  Isothermal ${st.temperature} K, drift-diffusion, no Thermodynamic.`);
    P('*');
    P(`*  BIAS: ${d.source.name} = 0 V, ${d.gate.name} and ${d.drain.name} driven ` +
      (sgn < 0 ? 'NEGATIVE.' : 'POSITIVE.'));
    if (sgn < 0) P('*        Drain TotalCurrent is NEGATIVE -- plot |Id| on a log axis.');
    P('*');
    P('*  OUTPUT FILES (x-axis column in brackets)');
    if (b.idvgLin) P(`*    ${name}_IdVg_Vd${vTag(vlin)}_des.plt   Id-Vg, Vds = ${vc(vlin)} V  [${d.gate.name}]`);
    if (b.idvgSat) P(`*    ${name}_IdVg_Vd${vTag(vdd)}_des.plt   Id-Vg, Vds = ${vc(vdd)} V  [${d.gate.name}]`);
    if (b.idvd) {
      for (const vg of b.vgSteps) {
        P(`*    ${name}_IdVd_Vg${vTag(sgn * vg)}_des.plt   Id-Vd, Vgs = ${vc(sgn * vg)} V  [${d.drain.name}]`);
      }
    }
    if (b.onStateSnapshot && b.idvgSat) {
      P(`*    ${name}_OnState_Vg${vTag(vdd)}_Vd${vTag(vdd)}   field snapshot (.tdr)`);
    }
    P('* ' + '='.repeat(74));
    P('');

    /* ---------------- File ---------------- */
    P('File {');
    P(`   Grid    = "${st.grid}"`);
    P(`   Plot    = "${name}_final"`);
    P(`   Current = "${name}_init"`);
    P(`   Output  = "${name}_log"`);
    P('}');
    P('');

    /* ---------------- Electrode ----------------
       The driven device first, then everything else grounded, so the
       deck reads in the order it is used. */
    const mine = [d.source.name, d.drain.name, d.gate.name];
    P('Electrode {');
    for (const nm of mine) P(`   { Name = "${nm}"${pad(nm)}Voltage = 0.0 }`);
    const idle = elec.filter((e) => !mine.includes(e.name));
    if (idle.length) {
      P(`   * ---- idle ${T === 'n' ? 'pMOS' : 'nMOS'} and substrate, all grounded ----`);
      for (const e of idle) P(`   { Name = "${e.name}"${pad(e.name)}Voltage = 0.0 }`);
    }
    P('}');
    P('');

    /* ---------------- Physics ---------------- */
    const ph = st.physics;
    P('Physics {');
    P(`   Temperature = ${st.temperature}`);
    P(`   AreaFactor  = ${st.areaFactor}`);
    const mob = [];
    if (ph.mobDoping) mob.push('DopingDependence');
    if (ph.mobEnormal) mob.push('Enormal');
    if (ph.mobHighField) mob.push('HighFieldSaturation');
    if (mob.length) P(`   Mobility ( ${mob.join(' ')} )`);
    if (ph.srh) P('   Recombination ( SRH ( DopingDependence ) )');
    if (ph.eid) P('   EffectiveIntrinsicDensity ( OldSlotboom )');
    P('}');
    P('');

    /* ---------------- per-gate workfunction ----------------
       The threshold knob. Applied region by region because the gate is
       built from several abutting metal pieces, and a Physics(Region=)
       block covers exactly one of them. The idle device keeps its own
       workfunction so it stays off rather than inverting by accident. */
    for (const dd of devs) {
      const gates = gateRegionsOf(regions, dd.tag);
      if (!gates.length) continue;
      const w = st.workfunction[dd.tag];
      P(`* ---- ${dd.tag.toUpperCase()}MOS gate workfunction` +
        (dd.tag === T ? ' (Vth knob) ----' : ' -- keeps the idle device OFF ----'));
      const wide = Math.max(...gates.map((x) => x.length));
      for (const gname of gates) {
        P(`Physics ( Region = "${gname}"${' '.repeat(wide - gname.length)} ) ` +
          `{ MetalWorkfunction ( Workfunction = ${Number(w).toFixed(2)} ) }`);
      }
      P('');
    }

    /* ---------------- Plot ---------------- */
    const pl = st.plot;
    P('Plot {');
    if (pl.carriers) P('   eDensity  hDensity');
    if (pl.current) P('   eCurrent/Vector  hCurrent/Vector  Current/Vector');
    if (pl.potential) P('   Potential  ElectricField/Vector  SpaceCharge');
    if (pl.doping) P('   Doping  DonorConcentration  AcceptorConcentration');
    if (pl.quasiFermi) P('   eQuasiFermiPotential  hQuasiFermiPotential');
    if (pl.bands) P('   ConductionBandEnergy  ValenceBandEnergy');
    if (pl.mobility) P('   eMobility  hMobility');
    P('}');
    P('');

    /* ---------------- Math ---------------- */
    const m = st.math;
    P('Math {');
    P('   Extrapolate');
    P('   Derivatives');
    P('   RelErrControl');
    P(`   Digits           = ${m.digits}`);
    P(`   ErrRef(electron) = ${m.errRef}`);
    P(`   ErrRef(hole)     = ${m.errRef}`);
    P(`   Iterations       = ${m.iterations}`);
    P(`   Notdamped        = ${m.notdamped}`);
    P('   ExitOnFailure');
    P(`   NumberOfThreads  = ${m.threads}`);
    P(`   Method           = ${m.method}`);
    P(`   RhsMin           = ${m.rhsMin}`);
    P('}');
    P('');

    /* ---------------- Solve ---------------- */
    P(...solveBlock(st, d, name, sgn));
    return L.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
  }

  function pad(nm) {
    return ' '.repeat(Math.max(1, 11 - nm.length));
  }

  /** The coupled set these decks solve: isothermal drift-diffusion. */
  function coupled() { return 'Coupled { Poisson Electron Hole }'; }

  /** A setup ramp: get somewhere, no measurement. */
  function goTo(pairs, step, maxStep) {
    const L = [];
    L.push(`   Quasistationary ( InitialStep = ${step} MinStep = 1e-5 MaxStep = ${maxStep}`);
    for (const [nm, v] of pairs) L.push(`      Goal { Name = "${nm}" Voltage = ${volts(v)} }`);
    L.push(`   ) { ${coupled()} }`);
    L.push('');
    return L;
  }

  /** A measured sweep: finer steps, and a CurrentPlot so points land in the .plt. */
  function measure(nm, v, st, prefix) {
    const b = st.bias;
    return [
      `   NewCurrentPrefix = "${prefix}"`,
      `   Quasistationary ( InitialStep = ${b.sweepStep} MinStep = 1e-5 MaxStep = ${b.sweepStep}`,
      `      Goal { Name = "${nm}" Voltage = ${volts(v)} }`,
      `   ) { ${coupled()}`,
      `       CurrentPlot ( Time = (Range = (0 1) Intervals = ${b.intervals}) ) }`,
      '',
    ];
  }

  function solveBlock(st, d, name, sgn) {
    const L = [];
    const b = st.bias;
    const G = d.gate.name, D = d.drain.name;
    const vdd = sgn * b.vdd, vlin = sgn * b.vdlin;
    let n = 0;

    L.push('Solve {');
    L.push('');
    L.push('   * ---- equilibrium ----');
    L.push('   Coupled ( Iterations = 150 ) { Poisson }');
    L.push('   Coupled ( Iterations = 100 ) { Poisson Electron Hole }');
    L.push('');

    const head = (title) => {
      n += 1;
      L.push('   * ' + '='.repeat(70));
      L.push(`   * ${n}. ${title}`);
      L.push('   * ' + '='.repeat(70));
    };
    const reset = (pairs, tag) => {
      L.push(`   * ---- return to 0 V ----`);
      L.push(`   NewCurrentPrefix = "${name}_${tag}_"`);
      L.push(...goTo(pairs, '0.05', '0.1'));
    };

    if (b.idvgLin) {
      head(`Id-Vg at Vds = ${vc(vlin)} V${' '.repeat(8)}x-axis: ${G}`);
      L.push(`   * ---- ramp drain to Vds = ${vc(vlin)} V ----`);
      L.push(...goTo([[D, vlin]], '0.05', '0.1'));
      L.push(`   * ---- gate sweep: Vgs = 0 to ${vc(vdd)} V at fixed Vds = ${vc(vlin)} V ----`);
      L.push(...measure(G, vdd, st, `${name}_IdVg_Vd${vTag(vlin)}_`));
      reset([[G, 0], [D, 0]], 'reset1');
    }

    if (b.idvgSat) {
      head(`Id-Vg at Vds = ${vc(vdd)} V${' '.repeat(8)}x-axis: ${G}`);
      L.push(`   * ---- ramp drain to Vds = ${vc(vdd)} V ----`);
      L.push(...goTo([[D, vdd]], '0.02', '0.05'));
      L.push(`   * ---- gate sweep: Vgs = 0 to ${vc(vdd)} V at fixed Vds = ${vc(vdd)} V ----`);
      L.push(...measure(G, vdd, st, `${name}_IdVg_Vd${vTag(vdd)}_`));
      if (b.onStateSnapshot) {
        L.push(`   Plot ( FilePrefix = "${name}_OnState_Vg${vTag(vdd)}_Vd${vTag(vdd)}" )`);
        L.push('');
      }
      reset([[G, 0], [D, 0]], 'reset2');
    }

    if (b.idvd) {
      let prev = 0;
      b.vgSteps.forEach((vgAbs, i) => {
        const vg = sgn * vgAbs;
        head(`Id-Vd at Vgs = ${vc(vg)} V${' '.repeat(8)}x-axis: ${D}`);
        L.push(i === 0
          ? `   * ---- set gate to Vgs = ${vc(vg)} V ----`
          : `   * ---- step gate from ${vc(prev)} V to ${vc(vg)} V ----`);
        L.push(...goTo([[G, vg]], '0.05', '0.1'));
        L.push(`   * ---- drain sweep: Vds = 0 to ${vc(vdd)} V at fixed Vgs = ${vc(vg)} V ----`);
        L.push(...measure(D, vdd, st, `${name}_IdVd_Vg${vTag(vg)}_`));
        // the last family member leaves the device biased; nothing follows it
        if (i < b.vgSteps.length - 1) {
          L.push('   * ---- return drain to 0 V ----');
          L.push(`   NewCurrentPrefix = "${name}_reset${i + 3}_"`);
          L.push(...goTo([[D, 0]], '0.05', '0.1'));
        }
        prev = vg;
      });
    }

    L.push('}');
    return L;
  }


  /* ==================================================================
     3. VALIDATION
     ==================================================================
     Run before anything is generated. A finding that would make the deck
     wrong is an error and blocks generation; anything that only limits
     what can be extracted is a warning.
     ================================================================== */

  function validate(parsed, analysis, st) {
    const out = [];
    const ok = (m) => out.push({ level: 'ok', message: m });
    const warn = (m) => out.push({ level: 'warn', message: m });
    const err = (m) => out.push({ level: 'error', message: m });

    const regions = parsed.regions || [];
    const contacts = parsed.contacts || [];
    const elec = classifyElectrodes(contacts);
    const devs = devicesOf(elec);

    /* ---- structure ---- */
    if (!regions.length) err('No regions found - the SCM did not yield any geometry.');
    else ok(`${regions.length} regions detected`);

    const mats = [...new Set(regions.map((r) => r.material))];
    if (!mats.length) err('No materials found.');
    else ok(`${mats.length} materials detected: ${mats.join(', ')}`);

    const semi = regions.filter((r) => /^(silicon|germanium|sige)$/i.test(r.material));
    if (!semi.length) err('No semiconductor region - SDevice has nothing to solve in.');
    else ok(`${semi.length} semiconductor regions`);

    if (!contacts.length) {
      err('No contacts defined - a device with no electrodes cannot be biased.');
    } else {
      ok(`${contacts.length} contacts detected: ${contacts.map((c) => c.name).join(', ')}`);
    }

    /* every contact must actually land on a region, or the mesh will not
       carry it and SDevice will abort on the Electrode block */
    for (const c of contacts) {
      const pts = (c.faces || []).filter(Boolean);
      if (!pts.length) {
        warn(`Contact "${c.name}" is declared but never placed on a face - ` +
             `it may not exist in the mesh.`);
        continue;
      }
      const landed = pts.some((p) => regions.some((r) =>
        p.x >= r.x0 - 1e-9 && p.x <= r.x1 + 1e-9 &&
        p.y >= r.y0 - 1e-9 && p.y <= r.y1 + 1e-9 &&
        p.z >= r.z0 - 1e-9 && p.z <= r.z1 + 1e-9));
      if (!landed) {
        err(`Contact "${c.name}" picks a point that is not on any region - ` +
            `the electrode will be missing from the mesh.`);
      }
    }

    /* ---- per-device completeness ---- */
    if (!devs.length) {
      const roles = elec.map((e) => `${e.name}:${e.role}`).join(', ');
      err('No complete device found. A device needs a gate, a source and a ' +
          `drain that share an n/p tag. Detected roles: ${roles || 'none'}.`);
    }
    for (const d of devs) {
      ok(`${d.tag.toUpperCase()}MOS complete: gate "${d.gate.name}", ` +
         `source "${d.source.name}", drain "${d.drain.name}"`);
    }

    /* an electrode with no obvious role is not an error, but the deck
       will leave it at 0 V and the user should know that */
    for (const e of elec) {
      if (e.role === 'other') {
        warn(`Electrode "${e.name}" has no recognised role - it is declared ` +
             `and held at 0 V, but nothing sweeps it.`);
      }
    }

    /* a body region with no electrode floats: converges, wrong answer */
    for (const d of devs) {
      if (d.tag !== 'p') continue;
      if (!d.well) {
        warn(`No well or body electrode for the PMOS. If its source/drain sit ` +
             `on a well region with no contact, that body floats and the ` +
             `parasitic bipolar can swamp the channel current.`);
      } else {
        ok(`PMOS body electrode "${d.well.name}" present`);
      }
    }

    /* ---- mesh ---- */
    if (!parsed.meshPrefix) {
      warn('No sde:build-mesh call found - the Grid filename is a guess. ' +
           'Check the File block before running.');
    } else {
      ok(`Grid file: ${st.grid}`);
    }

    /* ---- these decks are isothermal by construction ---- */
    ok(`Isothermal ${st.temperature} K, drift-diffusion - no Thermodynamic`);

    /* ---- bias ---- */
    const want = st.device === 'both' ? devs : devs.filter((d) => d.tag === st.device);
    if (!want.length) {
      err(`No ${st.device === 'n' ? 'n' : 'p'}MOS was found in this structure, ` +
          `so the selected deck cannot be written.`);
    }
    for (const d of want) {
      for (const e of [d.gate, d.source, d.drain]) {
        if (!contacts.some((c) => c.name === e.name)) {
          err(`Bias references electrode "${e.name}", which is not in the structure.`);
        }
      }
      const gates = regions.filter((r) => /tin|tungsten|metal|poly/i.test(r.material) &&
        r.name.startsWith(d.tag + '_')).length;
      if (!gates) {
        err(`No gate metal regions found for the ${d.tag.toUpperCase()}MOS, so no ` +
            `workfunction can be applied - the threshold would be undefined.`);
      } else {
        ok(`${d.tag.toUpperCase()}MOS gate: ${gates} metal region(s) at ` +
           `${st.workfunction[d.tag]} eV`);
      }
      /* The pMOS body needs a terminal. Without one the well floats, the
         p+/well junction forward-biases and the open-base bipolar carries
         the current instead of the channel - the Id-Vg stops being gate
         controlled. That is a property of the structure, not the deck, so
         it is a warning here rather than an error. */
      if (d.tag === 'p' && !d.well) {
        warn('The pMOS body has no electrode in this structure, so the n-well ' +
             'floats. Expect the drain current to be dominated by the open-base ' +
             'p+/n/p+ path and to be insensitive to the gate.');
      }
    }
    if (!(st.bias.vdd > 0)) err('Supply voltage must be positive.');
    if (!(st.bias.sweepStep > 0)) err('Sweep step must be positive.');
    for (const vg of st.bias.vgSteps || []) {
      if (!(vg >= 0)) err(`Id-Vd gate step ${vg} must be zero or positive; ` +
                          `the sign is applied per device.`);
    }
    ok(`Sweeps: ${[st.bias.idvgLin && 'Id-Vg linear', st.bias.idvgSat && 'Id-Vg saturation',
        st.bias.idvd && `Id-Vd x${(st.bias.vgSteps || []).length}`]
        .filter(Boolean).join(', ') || 'none selected'}`);

    return { findings: out, ok: !out.some((f) => f.level === 'error'), electrodes: elec, devices: devs };
  }

  /** Regions worth a per-device temperature column: the drain and the hottest channel. */
  function currentPlotRegions(regions, devs) {
    const picked = [];
    for (const d of devs) {
      const drain = regions.find((r) =>
        new RegExp(`^${d.tag}_?drain$`, 'i').test(r.name));
      if (drain) picked.push(drain.name);
      // the topmost channel segment is the furthest from the heat sink
      const chans = regions.filter((r) =>
        new RegExp(`^${d.tag}_`, 'i').test(r.name) && /chan/i.test(r.name));
      if (chans.length) {
        picked.push(chans.slice().sort((a, b) => b.y1 - a.y1)[0].name);
      }
    }
    return picked;
  }


  /* ==================================================================
     5. MESH REFINEMENT BLOCK
     ==================================================================
     Mesh refinement is defined in the SDE script, not in sdevice.cmd -
     by the time SDevice runs, the mesh is already a .tdr file. So the
     slider writes SCM commands, to be pasted in before meshing, rather
     than pretending to change something the command file controls.
     ================================================================== */

  function buildMeshBlock(parsed, analysis, sizeNm) {
    const um = Math.max(0.0002, sizeNm / 1000);
    const regions = parsed.regions || [];
    if (!regions.length) return '';

    const b = window.SDEAnalyze ? window.SDEAnalyze.boundsOf(regions) : null;
    if (!b) return '';

    const fine = um;                 // at the features that matter
    const coarse = um * 8;           // in the bulk, where nothing is thin
    const mid = um * 3;
    const q = (v) => Number(v.toPrecision(3));
    const pos = (x, y, z) => `(position ${Number(x.toPrecision(6))} ` +
                             `${Number(y.toPrecision(6))} ${Number(z.toPrecision(6))})`;

    const L = [];
    L.push(';; ---- mesh refinement, generated for the loaded structure ----');
    L.push(`;;  target element size ${sizeNm} nm at the active regions.`);
    L.push(';;  Paste into the SCM before (sde:build-mesh ...).');
    L.push('');
    L.push(`(sdedr:define-refinement-size "RS_global" ${q(coarse)} ${q(coarse)} ${q(coarse)} ` +
           `${q(mid)} ${q(mid)} ${q(mid)})`);
    L.push(`(sdedr:define-refinement-window "RW_global" "Cuboid" ` +
           `${pos(b.x0, b.y0, b.z0)} ${pos(b.x1, b.y1, b.z1)})`);
    L.push('(sdedr:define-refinement-placement "RP_global" "RS_global" "RW_global")');
    L.push('');

    /* the active band: everything above the substrate top */
    const above = regions.filter((r) => r.y1 > 1e-9 && r.y0 >= -1e-9);
    if (above.length) {
      const a = window.SDEAnalyze.boundsOf(above);
      L.push(`(sdedr:define-refinement-size "RS_active" ${q(mid)} ${q(fine)} ${q(mid)} ` +
             `${q(fine)} ${q(fine / 2)} ${q(fine)})`);
      L.push(`(sdedr:define-refinement-window "RW_active" "Cuboid" ` +
             `${pos(a.x0, a.y0, a.z0)} ${pos(a.x1, a.y1, a.z1)})`);
      L.push('(sdedr:define-refinement-placement "RP_active" "RS_active" "RW_active")');
      L.push('');
    }

    /* the gate dielectric is the thinnest thing in the structure, so it
       sets the Y minimum; X and Z stay coarse because nothing is thin there */
    const diel = regions.filter((r) => /hfo2|sio2|al2o3|zro2/i.test(r.material));
    if (diel.length) {
      const thin = Math.min(...diel.map((r) =>
        Math.min(r.x1 - r.x0, r.y1 - r.y0, r.z1 - r.z0)));
      const dy = Math.max(0.0002, Math.min(fine / 2, thin / 3));
      const d = window.SDEAnalyze.boundsOf(diel);
      L.push(`;;  thinnest dielectric is ${Number((thin * 1000).toPrecision(3))} nm, so Y is resolved to ${Number((dy * 1000).toPrecision(3))} nm`);
      L.push(`(sdedr:define-refinement-size "RS_diel" ${q(mid)} ${q(dy * 2)} ${q(mid)} ` +
             `${q(fine)} ${q(dy)} ${q(fine)})`);
      L.push(`(sdedr:define-refinement-window "RW_diel" "Cuboid" ` +
             `${pos(d.x0, d.y0, d.z0)} ${pos(d.x1, d.y1, d.z1)})`);
      L.push('(sdedr:define-refinement-placement "RP_diel" "RS_diel" "RW_diel")');
      L.push('');
    }

    /* the deep substrate carries heat, not current: coarse is fine */
    const below = regions.filter((r) => r.y0 < -1e-9);
    if (below.length) {
      const s = window.SDEAnalyze.boundsOf(below);
      L.push(`(sdedr:define-refinement-size "RS_sub" ${q(coarse * 1.5)} ${q(coarse * 1.5)} ` +
             `${q(coarse * 1.5)} ${q(mid)} ${q(mid)} ${q(mid)})`);
      L.push(`(sdedr:define-refinement-window "RW_sub" "Cuboid" ` +
             `${pos(s.x0, s.y0, s.z0)} ${pos(s.x1, s.y1, s.z1)})`);
      L.push('(sdedr:define-refinement-placement "RP_sub" "RS_sub" "RW_sub")');
    }

    return L.join('\n') + '\n';
  }


  window.SDevice = {
    classifyElectrodes, devicesOf, defaultSettings,
    validate, buildSdevice, buildDecks, buildMeshBlock, currentPlotRegions,
  };

})();
