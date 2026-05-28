/**
 * Hardcoded canonical antibody constant-region sequences for chain
 * identification + position mapping. NO network calls — these are
 * public-domain factual sequences from UniProt.
 *
 * Verify any change against the cited UniProt accession:
 *   IgG1 heavy   — P01857   https://www.uniprot.org/uniprot/P01857
 *   IgG2 heavy   — P01859   https://www.uniprot.org/uniprot/P01859
 *   IgG3 heavy   — P01860   https://www.uniprot.org/uniprot/P01860
 *   IgG4 heavy   — P01861   https://www.uniprot.org/uniprot/P01861
 *   κ light      — P01834   https://www.uniprot.org/uniprot/P01834
 *   λ light (λ1) — P0CG04   https://www.uniprot.org/uniprot/P0CG04
 *
 * EU heavy-chain anchors used throughout the app (must stay correct):
 *   118 — first residue of CH1 (A of ASTKG...)
 *   216 — first residue of hinge (E of EPKSCDKTHT...)
 *   231 — first residue of CH2 (A of APELLGG...)
 *   297 — N-glycosylation site (N in EEQYNSTYR)
 *   341 — first residue of CH3
 *   447 — terminal K of CH3 (last residue)
 *
 * `verifyReferences()` runs on first import and throws if any landmark
 * disagrees — surfaces a typo immediately instead of silently mis-classifying.
 */

export type HCSubclass = 'IgG1' | 'IgG2' | 'IgG3' | 'IgG4'
export type LCSubclass = 'kappa' | 'lambda'

export interface CHRef {
  subclass: HCSubclass
  uniprot: string
  /** Heavy-chain constant region: CH1 + hinge + CH2 + CH3. No signal, no VH.
   *  First residue is EU position 118 (A of ASTKGPS...). */
  sequence: string
  /** EU number assigned to sequence[0]. Always 118 for human IgGs. */
  euStart: 118
  /** Inclusive EU domain spans. Hinge length differs across subclasses. */
  domains: {
    CH1: [118, 215]
    hinge: [number, number]
    CH2: [number, number]
    CH3: [number, number]
  }
  /** Sanity-check residues — sequence[eu - euStart] === aa */
  landmarks: Array<{ eu: number; aa: string }>
}

export interface CLRef {
  subclass: LCSubclass
  uniprot: string
  /** Light-chain constant region (CL only). No VL. */
  sequence: string
  /** Used for position mapping on the light chain. Light chain positions are
   *  domain-specific (not 1-based across full chain) — these are 1-based
   *  within CL. */
  landmarks: Array<{ position: number; aa: string }>
}

/* ────────────────────────────────────────────────────────────────────────
 * Heavy chain constant regions (EU 118-447)
 * ──────────────────────────────────────────────────────────────────────── */

// IgG1 (P01857) — CH1+hinge(EPKSCDKTHTCPPCP)+CH2+CH3 = 330 aa, EU 118-447.
const IGG1_CH =
  'ASTKGPSVFPLAPSSKSTSGGTAALGCLVKDYFPEPVTVSWNSGALTSGVHTFPAVLQSSGLYSLSSVVTVPSSSLGTQTYICNVNHKPSNTKVDKKVEPKSCDKTHTCPPCPAPELLGGPSVFLFPPKPKDTLMISRTPEVTCVVVDVSHEDPEVKFNWYVDGVEVHNAKTKPREEQYNSTYRVVSVLTVLHQDWLNGKEYKCKVSNKALPAPIEKTISKAKGQPREPQVYTLPPSRDELTKNQVSLTCLVKGFYPSDIAVEWESNGQPENNYKTTPPVLDSDGSFFLYSKLTVDKSRWQQGNVFSCSVMHEALHNHYTQKSLSLSPGK'

// IgG2 (P01859) — shorter hinge ERKCCVECPPCP (12 aa); CH2 has VVVDVSHEDPEVQ
// (V297Q vs IgG1's V297K... actually no — N297 is the glycan site, stays N)
// and a few characteristic residues.
const IGG2_CH =
  'ASTKGPSVFPLAPCSRSTSESTAALGCLVKDYFPEPVTVSWNSGALTSGVHTFPAVLQSSGLYSLSSVVTVPSSNFGTQTYTCNVDHKPSNTKVDKTVERKCCVECPPCPAPPVAGPSVFLFPPKPKDTLMISRTPEVTCVVVDVSHEDPEVQFNWYVDGVEVHNAKTKPREEQFNSTFRVVSVLTVVHQDWLNGKEYKCKVSNKGLPAPIEKTISKTKGQPREPQVYTLPPSREEMTKNQVSLTCLVKGFYPSDISVEWESNGQPENNYKTTPPMLDSDGSFFLYSKLTVDKSRWQQGNVFSCSVMHEALHNHYTQKSLSLSPGK'

// IgG3 (P01860) — long flexible hinge (multiple repeats), most variable
// between allotypes. This is the canonical G3m(b) reference. The hinge is
// ~62 aa; CH2/CH3 are nearly identical to IgG1.
const IGG3_CH =
  'ASTKGPSVFPLAPCSRSTSGGTAALGCLVKDYFPEPVTVSWNSGALTSGVHTFPAVLQSSGLYSLSSVVTVPSSSLGTQTYTCNVNHKPSNTKVDKRVELKTPLGDTTHTCPRCPEPKSCDTPPPCPRCPEPKSCDTPPPCPRCPEPKSCDTPPPCPRCPAPELLGGPSVFLFPPKPKDTLMISRTPEVTCVVVDVSHEDPEVQFKWYVDGVEVHNAKTKPREEQYNSTFRVVSVLTVLHQDWLNGKEYKCKVSNKALPAPIEKTISKTKGQPREPQVYTLPPSREEMTKNQVSLTCLVKGFYPSDIAVEWESSGQPENNYNTTPPMLDSDGSFFLYSKLTVDKSRWQQGNIFSCSVMHEALHNRFTQKSLSLSPGK'

// IgG4 (P01861) — short stabilising hinge ESKYGPPCPSCP (12 aa, wild-type S228
// not the engineered P228), and several characteristic CH2/CH3 residues
// including F234/L235→F/L (wild-type) and YGPP hinge.
const IGG4_CH =
  'ASTKGPSVFPLAPCSRSTSESTAALGCLVKDYFPEPVTVSWNSGALTSGVHTFPAVLQSSGLYSLSSVVTVPSSSLGTKTYTCNVDHKPSNTKVDKRVESKYGPPCPSCPAPEFLGGPSVFLFPPKPKDTLMISRTPEVTCVVVDVSQEDPEVQFNWYVDGVEVHNAKTKPREEQFNSTYRVVSVLTVLHQDWLNGKEYKCKVSNKGLPSSIEKTISKAKGQPREPQVYTLPPSQEEMTKNQVSLTCLVKGFYPSDIAVEWESNGQPENNYKTTPPVLDSDGSFFLYSRLTVDKSRWQEGNVFSCSVMHEALHNHYTQKSLSLSLGK'

/**
 * EU positional indexing note. EU numbering preserves *homology* across IgG
 * subclasses: equivalent positions (e.g. the glycan-anchor Asn 297, the
 * IgG–FcγR contact at K322) have the *same* EU number in IgG1/2/3/4, even
 * though the hinge lengths differ. The consequence: for IgG2/3/4,
 * `sequence[eu - euStart]` does NOT directly index — positions inside or
 * after the hinge need a per-subclass offset table.
 *
 * For v1 we only ship landmark-verified IgG1, kappa, and lambda. IgG2/3/4
 * sequences are included for NW alignment / soft classification (CH2+CH3
 * are >95% identical to IgG1, so NW still picks them out), but no EU-index
 * landmarks are asserted for them. Subclass discrimination relies on
 * diagnostic residues; the mutation-position mapping always renumbers via
 * `dvbfixer renumber --scheme EU` before applying mutations, so an
 * imperfect IgG2/3/4 reference doesn't break the pipeline.
 */
export const HC_REFS: Record<HCSubclass, CHRef> = {
  IgG1: {
    subclass: 'IgG1', uniprot: 'P01857', sequence: IGG1_CH, euStart: 118,
    domains: { CH1: [118, 215], hinge: [216, 230], CH2: [231, 340], CH3: [341, 447] },
    landmarks: [
      { eu: 118, aa: 'A' },                  // start of CH1
      { eu: 216, aa: 'E' },                  // start of hinge (EPKSCDKTHTCPPCP)
      { eu: 234, aa: 'L' }, { eu: 235, aa: 'L' },  // LALA target residues
      { eu: 252, aa: 'M' }, { eu: 254, aa: 'S' }, { eu: 256, aa: 'T' },  // YTE residues
      { eu: 297, aa: 'N' },                  // N-glycosylation site
      { eu: 322, aa: 'K' },                  // K322A target
      { eu: 329, aa: 'P' },
      { eu: 405, aa: 'F' },                  // F405L target
      { eu: 446, aa: 'G' }, { eu: 447, aa: 'K' },  // delGK target residues
    ],
  },
  IgG2: {
    subclass: 'IgG2', uniprot: 'P01859', sequence: IGG2_CH, euStart: 118,
    domains: { CH1: [118, 215], hinge: [216, 227], CH2: [228, 340], CH3: [341, 447] },
    landmarks: [
      { eu: 118, aa: 'A' },                  // unambiguous in CH1, before any hinge offset
    ],
  },
  IgG3: {
    subclass: 'IgG3', uniprot: 'P01860', sequence: IGG3_CH, euStart: 118,
    domains: { CH1: [118, 215], hinge: [216, 277], CH2: [278, 390], CH3: [391, 497] },
    landmarks: [
      { eu: 118, aa: 'A' },
    ],
  },
  IgG4: {
    subclass: 'IgG4', uniprot: 'P01861', sequence: IGG4_CH, euStart: 118,
    domains: { CH1: [118, 215], hinge: [216, 227], CH2: [228, 340], CH3: [341, 447] },
    landmarks: [
      { eu: 118, aa: 'A' },
    ],
  },
}

/* ────────────────────────────────────────────────────────────────────────
 * Light chain constant regions
 * ──────────────────────────────────────────────────────────────────────── */

// Kappa CL (P01834), 107 aa.
const KAPPA_CL =
  'RTVAAPSVFIFPPSDEQLKSGTASVVCLLNNFYPREAKVQWKVDNALQSGNSQESVTEQDSKDSTYSLSSTLTLSKADYEKHKVYACEVTHQGLSSPVTKSFNRGEC'

// Lambda CL (P0CG04, IGLC2), 105 aa. λ1/2/3/7 differ by ≤3 residues — single
// reference is enough for κ-vs-λ discrimination.
const LAMBDA_CL =
  'GQPKAAPSVTLFPPSSEELQANKATLVCLISDFYPGAVTVAWKADSSPVKAGVETTTPSKQSNNKYAASSYLSLTPEQWKSHRSYSCQVTHEGSTVEKTVAPTECS'

export const LC_REFS: Record<LCSubclass, CLRef> = {
  kappa: {
    subclass: 'kappa', uniprot: 'P01834', sequence: KAPPA_CL,
    landmarks: [
      { position: 1, aa: 'R' },              // RTVAAPSVFI...
    ],
  },
  lambda: {
    subclass: 'lambda', uniprot: 'P0CG04', sequence: LAMBDA_CL,
    landmarks: [
      { position: 1, aa: 'G' },              // GQPKAAPSV...
    ],
  },
}

/* ────────────────────────────────────────────────────────────────────────
 * Self-check: verify every landmark on module load.
 * Throws immediately if a sequence string was mis-typed — surfaces bugs at
 * import time instead of through silently-wrong alignments.
 * ──────────────────────────────────────────────────────────────────────── */

function verifyReferences(): void {
  for (const ref of Object.values(HC_REFS)) {
    for (const { eu, aa } of ref.landmarks) {
      const idx = eu - ref.euStart
      const got = ref.sequence[idx]
      if (got !== aa) {
        throw new Error(
          `[antibody-references] ${ref.subclass} (${ref.uniprot}) landmark ` +
          `mismatch at EU ${eu}: expected '${aa}', got '${got ?? '<oob>'}' ` +
          `(sequence length ${ref.sequence.length}). Verify against UniProt ${ref.uniprot}.`
        )
      }
    }
  }
  for (const ref of Object.values(LC_REFS)) {
    for (const { position, aa } of ref.landmarks) {
      const got = ref.sequence[position - 1]
      if (got !== aa) {
        throw new Error(
          `[antibody-references] ${ref.subclass} (${ref.uniprot}) landmark ` +
          `mismatch at CL position ${position}: expected '${aa}', got '${got ?? '<oob>'}'.`
        )
      }
    }
  }
}

verifyReferences()
