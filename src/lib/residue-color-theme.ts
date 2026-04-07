import { Color } from 'molstar/lib/mol-util/color'
import { ColorTheme } from 'molstar/lib/mol-theme/color'
import type { ThemeDataContext } from 'molstar/lib/mol-theme/theme'
import { ParamDefinition as PD } from 'molstar/lib/mol-util/param-definition'
import { StructureElement, Bond, Unit } from 'molstar/lib/mol-model/structure'
import { threeToOne } from './residue-codes'

// Carbon colors by residue type
const HYDROPHOBIC = Color(0x6de17b)
const POSITIVE    = Color(0x597deb)
const NEGATIVE    = Color(0xe33763)
const POLAR       = Color(0xffaa65)
const CYSTEINE    = Color(0xfffa5a)
const AROMATIC    = Color(0x67c2b9)
const SPECIAL_    = Color(0xfb86dd)
const DEFAULT_C   = Color(0xaaaaaa)

const ONE_TO_COLOR: Record<string, Color> = {
  A: HYDROPHOBIC, I: HYDROPHOBIC, L: HYDROPHOBIC, M: HYDROPHOBIC, V: HYDROPHOBIC,
  K: POSITIVE, R: POSITIVE, H: POSITIVE,
  E: NEGATIVE, D: NEGATIVE,
  Q: POLAR, N: POLAR, S: POLAR, T: POLAR,
  C: CYSTEINE,
  W: AROMATIC, Y: AROMATIC, F: AROMATIC,
  P: SPECIAL_, G: SPECIAL_,
}

// CPK element colors for non-carbon atoms
const ELEMENT_COLORS: Record<string, Color> = {
  N: Color(0x3050F8),   // nitrogen — blue
  O: Color(0xFF0D0D),   // oxygen — red
  S: Color(0xFFFF30),   // sulfur — yellow
  P: Color(0xFF8000),   // phosphorus — orange
  H: Color(0xCCCCCC),   // hydrogen — light grey
  FE: Color(0xE06633),  // iron
  ZN: Color(0x7D80B0),  // zinc
  CA: Color(0x3DFF00),  // calcium
  MG: Color(0x8AFF00),  // magnesium
  CL: Color(0x1FF01F),  // chlorine
  NA: Color(0xAB5CF2),  // sodium
  K: Color(0x8F40D4),   // potassium
  MN: Color(0x9C7AC7),  // manganese
  CU: Color(0xC88033),  // copper
  CO: Color(0xF090A0),  // cobalt
  NI: Color(0x50D050),  // nickel
  SE: Color(0xFFA100),  // selenium
  BR: Color(0xA62929),  // bromine
  I: Color(0x940094),   // iodine
  F: Color(0x90E050),   // fluorine
}
const DEFAULT_ELEMENT = Color(0xFF1493) // fallback for unknown elements

function getCarbonColor(compId: string): Color {
  const one = threeToOne(compId)
  return ONE_TO_COLOR[one] ?? DEFAULT_C
}

function getElementColor(element: string): Color {
  return ELEMENT_COLORS[element.toUpperCase()] ?? DEFAULT_ELEMENT
}

export const TarantinoResidueColorThemeParams = {}
export type TarantinoResidueColorThemeParams = typeof TarantinoResidueColorThemeParams

export function TarantinoResidueColorTheme(
  _ctx: ThemeDataContext,
  _props: PD.Values<TarantinoResidueColorThemeParams>
): ColorTheme<TarantinoResidueColorThemeParams> {

  function atomColor(unit: Unit, elementIndex: number): Color {
    if (!Unit.isAtomic(unit)) return DEFAULT_C
    const { type_symbol } = unit.model.atomicHierarchy.atoms
    const element = type_symbol.value(elementIndex) as string

    if (element === 'C') {
      // Carbon: color by residue type
      const compId = unit.model.atomicHierarchy.atoms.label_comp_id.value(elementIndex)
      return getCarbonColor(compId)
    }

    // Non-carbon: CPK element color
    return getElementColor(element)
  }

  return {
    factory: TarantinoResidueColorTheme,
    granularity: 'group',
    color: (location) => {
      if (StructureElement.Location.is(location)) {
        return atomColor(location.unit, location.element)
      }
      if (Bond.isLocation(location)) {
        // Use first atom's color for the bond
        return atomColor(location.aUnit, location.aUnit.elements[location.aIndex])
      }
      return DEFAULT_C
    },
    props: _props,
    description: 'Carbons colored by residue type, other atoms by element (CPK)',
  }
}

export const TarantinoResidueColorThemeProvider: ColorTheme.Provider<TarantinoResidueColorThemeParams, 'tarantino-residue-type'> = {
  name: 'tarantino-residue-type',
  label: 'Residue Type (Tarantino)',
  category: ColorTheme.Category.Residue,
  factory: TarantinoResidueColorTheme,
  getParams: () => ({}),
  defaultValues: PD.getDefaultValues(TarantinoResidueColorThemeParams),
  isApplicable: (_ctx) => true,
}
