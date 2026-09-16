/**
 * Deterministic geography normaliser for the Sede Judicial form
 * (comunidad autónoma / provincia / localidad / partido judicial).
 *
 * Only two data sources exist and both are deterministic:
 *   1. The embedded INE province and comunidad tables (stable public codes; the first two digits
 *      of a Spanish postal code are the INE province code).
 *   2. A reviewed catalog file mapping (province, municipality) -> partido judicial, supplied by
 *      the firm from the official publication and validated on load. No catalog is shipped.
 *
 * An LLM is never consulted; when a municipality is not in the catalog, or the inputs conflict,
 * the result is UNRESOLVED and the workflow escalates (GEO_UNRESOLVED). Nothing is invented.
 */

import { z } from 'zod';
import { GeoCatalogError, InvalidArgumentError } from '../domain/errors/index.js';
import { normalizeForMatch } from '../domain/text/normalize.js';

export interface ProvinceInfo {
  ineCode: string;
  name: string;
  comunidadIneCode: string;
}

export interface ComunidadInfo {
  ineCode: string;
  name: string;
}

interface ProvinceRow extends ProvinceInfo {
  aliases: readonly string[];
}

interface ComunidadRow extends ComunidadInfo {
  aliases: readonly string[];
}

/** INE comunidad autónoma codes (plus the autonomous cities 18/19). */
export const COMUNIDADES: readonly ComunidadRow[] = Object.freeze([
  { ineCode: '01', name: 'Andalucía', aliases: [] },
  { ineCode: '02', name: 'Aragón', aliases: [] },
  { ineCode: '03', name: 'Principado de Asturias', aliases: ['asturias'] },
  { ineCode: '04', name: 'Illes Balears', aliases: ['islas baleares', 'baleares', 'balears'] },
  { ineCode: '05', name: 'Canarias', aliases: ['islas canarias'] },
  { ineCode: '06', name: 'Cantabria', aliases: [] },
  { ineCode: '07', name: 'Castilla y León', aliases: ['castilla leon'] },
  { ineCode: '08', name: 'Castilla-La Mancha', aliases: ['castilla la mancha'] },
  { ineCode: '09', name: 'Cataluña', aliases: ['catalunya', 'cataluna'] },
  { ineCode: '10', name: 'Comunitat Valenciana', aliases: ['comunidad valenciana', 'pais valenciano', 'valencia'] },
  { ineCode: '11', name: 'Extremadura', aliases: [] },
  { ineCode: '12', name: 'Galicia', aliases: ['galiza'] },
  { ineCode: '13', name: 'Comunidad de Madrid', aliases: ['madrid'] },
  { ineCode: '14', name: 'Región de Murcia', aliases: ['murcia'] },
  { ineCode: '15', name: 'Comunidad Foral de Navarra', aliases: ['navarra', 'nafarroa'] },
  { ineCode: '16', name: 'País Vasco', aliases: ['euskadi', 'pais vasco'] },
  { ineCode: '17', name: 'La Rioja', aliases: ['rioja'] },
  { ineCode: '18', name: 'Ceuta', aliases: ['ciudad autonoma de ceuta'] },
  { ineCode: '19', name: 'Melilla', aliases: ['ciudad autonoma de melilla'] },
]);

/** INE province codes (also the first two digits of the postal code). */
export const PROVINCES: readonly ProvinceRow[] = Object.freeze([
  { ineCode: '01', name: 'Araba/Álava', comunidadIneCode: '16', aliases: ['alava', 'araba', 'araba alava', 'alava araba'] },
  { ineCode: '02', name: 'Albacete', comunidadIneCode: '08', aliases: [] },
  { ineCode: '03', name: 'Alicante/Alacant', comunidadIneCode: '10', aliases: ['alicante', 'alacant'] },
  { ineCode: '04', name: 'Almería', comunidadIneCode: '01', aliases: [] },
  { ineCode: '05', name: 'Ávila', comunidadIneCode: '07', aliases: [] },
  { ineCode: '06', name: 'Badajoz', comunidadIneCode: '11', aliases: [] },
  { ineCode: '07', name: 'Illes Balears', comunidadIneCode: '04', aliases: ['islas baleares', 'baleares', 'balears'] },
  { ineCode: '08', name: 'Barcelona', comunidadIneCode: '09', aliases: [] },
  { ineCode: '09', name: 'Burgos', comunidadIneCode: '07', aliases: [] },
  { ineCode: '10', name: 'Cáceres', comunidadIneCode: '11', aliases: [] },
  { ineCode: '11', name: 'Cádiz', comunidadIneCode: '01', aliases: [] },
  { ineCode: '12', name: 'Castellón/Castelló', comunidadIneCode: '10', aliases: ['castellon', 'castello', 'castellon de la plana', 'castello de la plana'] },
  { ineCode: '13', name: 'Ciudad Real', comunidadIneCode: '08', aliases: [] },
  { ineCode: '14', name: 'Córdoba', comunidadIneCode: '01', aliases: [] },
  { ineCode: '15', name: 'A Coruña', comunidadIneCode: '12', aliases: ['la coruna', 'coruna', 'a coruna'] },
  { ineCode: '16', name: 'Cuenca', comunidadIneCode: '08', aliases: [] },
  { ineCode: '17', name: 'Girona', comunidadIneCode: '09', aliases: ['gerona'] },
  { ineCode: '18', name: 'Granada', comunidadIneCode: '01', aliases: [] },
  { ineCode: '19', name: 'Guadalajara', comunidadIneCode: '08', aliases: [] },
  { ineCode: '20', name: 'Gipuzkoa', comunidadIneCode: '16', aliases: ['guipuzcoa'] },
  { ineCode: '21', name: 'Huelva', comunidadIneCode: '01', aliases: [] },
  { ineCode: '22', name: 'Huesca', comunidadIneCode: '02', aliases: [] },
  { ineCode: '23', name: 'Jaén', comunidadIneCode: '01', aliases: [] },
  { ineCode: '24', name: 'León', comunidadIneCode: '07', aliases: [] },
  { ineCode: '25', name: 'Lleida', comunidadIneCode: '09', aliases: ['lerida'] },
  { ineCode: '26', name: 'La Rioja', comunidadIneCode: '17', aliases: ['rioja'] },
  { ineCode: '27', name: 'Lugo', comunidadIneCode: '12', aliases: [] },
  { ineCode: '28', name: 'Madrid', comunidadIneCode: '13', aliases: [] },
  { ineCode: '29', name: 'Málaga', comunidadIneCode: '01', aliases: [] },
  { ineCode: '30', name: 'Murcia', comunidadIneCode: '14', aliases: [] },
  { ineCode: '31', name: 'Navarra', comunidadIneCode: '15', aliases: ['nafarroa', 'comunidad foral de navarra'] },
  { ineCode: '32', name: 'Ourense', comunidadIneCode: '12', aliases: ['orense'] },
  { ineCode: '33', name: 'Asturias', comunidadIneCode: '03', aliases: ['principado de asturias'] },
  { ineCode: '34', name: 'Palencia', comunidadIneCode: '07', aliases: [] },
  { ineCode: '35', name: 'Las Palmas', comunidadIneCode: '05', aliases: [] },
  { ineCode: '36', name: 'Pontevedra', comunidadIneCode: '12', aliases: [] },
  { ineCode: '37', name: 'Salamanca', comunidadIneCode: '07', aliases: [] },
  { ineCode: '38', name: 'Santa Cruz de Tenerife', comunidadIneCode: '05', aliases: ['tenerife', 's c de tenerife', 'sta cruz de tenerife'] },
  { ineCode: '39', name: 'Cantabria', comunidadIneCode: '06', aliases: [] },
  { ineCode: '40', name: 'Segovia', comunidadIneCode: '07', aliases: [] },
  { ineCode: '41', name: 'Sevilla', comunidadIneCode: '01', aliases: ['seville'] },
  { ineCode: '42', name: 'Soria', comunidadIneCode: '07', aliases: [] },
  { ineCode: '43', name: 'Tarragona', comunidadIneCode: '09', aliases: [] },
  { ineCode: '44', name: 'Teruel', comunidadIneCode: '02', aliases: [] },
  { ineCode: '45', name: 'Toledo', comunidadIneCode: '08', aliases: [] },
  { ineCode: '46', name: 'Valencia/València', comunidadIneCode: '10', aliases: ['valencia'] },
  { ineCode: '47', name: 'Valladolid', comunidadIneCode: '07', aliases: [] },
  { ineCode: '48', name: 'Bizkaia', comunidadIneCode: '16', aliases: ['vizcaya'] },
  { ineCode: '49', name: 'Zamora', comunidadIneCode: '07', aliases: [] },
  { ineCode: '50', name: 'Zaragoza', comunidadIneCode: '02', aliases: [] },
  { ineCode: '51', name: 'Ceuta', comunidadIneCode: '18', aliases: [] },
  { ineCode: '52', name: 'Melilla', comunidadIneCode: '19', aliases: [] },
]);

/** Reviewed catalog file shape (strict; unknown keys rejected). */
export const GeoCatalogSchema = z
  .object({
    version: z.string().min(1),
    /** Reference to the official publication the catalog was transcribed from. */
    source: z.string().min(1),
    reviewedBy: z.string().min(1),
    reviewedAt: z.string().datetime({ offset: true }),
    partidos: z
      .array(
        z
          .object({
            provinceIneCode: z.string().regex(/^\d{2}$/),
            name: z.string().min(1),
            sedeCode: z.string().min(1).optional(),
            municipalities: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export type GeoCatalog = z.infer<typeof GeoCatalogSchema>;

export interface GeoInput {
  codigoPostal?: string | null;
  provincia?: string | null;
  localidad?: string | null;
  comunidadAutonoma?: string | null;
}

export enum GeoReason {
  PROVINCE_UNKNOWN = 'PROVINCE_UNKNOWN',
  PROVINCE_NAME_UNRECOGNISED = 'PROVINCE_NAME_UNRECOGNISED',
  POSTAL_CODE_INVALID = 'POSTAL_CODE_INVALID',
  PROVINCE_CONFLICT = 'PROVINCE_CONFLICT',
  COMUNIDAD_NAME_UNRECOGNISED = 'COMUNIDAD_NAME_UNRECOGNISED',
  COMUNIDAD_CONFLICT = 'COMUNIDAD_CONFLICT',
  LOCALITY_MISSING = 'LOCALITY_MISSING',
  CATALOG_NOT_LOADED = 'CATALOG_NOT_LOADED',
  MUNICIPALITY_NOT_IN_CATALOG = 'MUNICIPALITY_NOT_IN_CATALOG',
}

export interface GeoResolution {
  status: 'RESOLVED' | 'UNRESOLVED';
  comunidadAutonoma: ComunidadInfo | null;
  provincia: ProvinceInfo | null;
  /** Canonical municipality name from the catalog (null when unresolved). */
  localidad: string | null;
  partidoJudicial: { name: string; sedeCode: string | null } | null;
  /** Blocking reasons (UNRESOLVED) or warnings (RESOLVED). */
  reasons: GeoReason[];
}

const PROVINCE_BY_CODE: ReadonlyMap<string, ProvinceRow> = new Map(PROVINCES.map((p) => [p.ineCode, p]));
const COMUNIDAD_BY_CODE: ReadonlyMap<string, ComunidadRow> = new Map(COMUNIDADES.map((c) => [c.ineCode, c]));

function buildNameIndex<T extends { name: string; aliases: readonly string[] }>(rows: readonly T[]): ReadonlyMap<string, T> {
  const index = new Map<string, T>();
  for (const row of rows) {
    for (const key of [row.name, ...row.name.split('/'), ...row.aliases]) {
      const normalized = normalizeForMatch(key);
      if (normalized) index.set(normalized, row);
    }
  }
  return index;
}

const PROVINCE_BY_NAME = buildNameIndex(PROVINCES);
const COMUNIDAD_BY_NAME = buildNameIndex(COMUNIDADES);

/** Candidate spellings for a municipality: as written, article moved, parentheses removed. */
export function municipalityKeys(raw: string): string[] {
  const keys = new Set<string>();
  const base = normalizeForMatch(raw);
  if (!base) return [];
  keys.add(base);
  const noParens = normalizeForMatch(raw.replace(/\([^)]*\)/g, ' '));
  if (noParens) keys.add(noParens);
  for (const source of [raw, raw.replace(/\([^)]*\)/g, ' ')]) {
    const m = /^(.+?),\s*(el|la|los|las|l'|els|les|es|sa|o|a|os|as)$/i.exec(source.trim());
    if (m && m[1] && m[2]) {
      const moved = normalizeForMatch(`${m[2]} ${m[1]}`);
      if (moved) keys.add(moved);
    }
  }
  return [...keys];
}

function stripInfo(row: ProvinceRow): ProvinceInfo {
  return { ineCode: row.ineCode, name: row.name, comunidadIneCode: row.comunidadIneCode };
}

export class GeoNormalizer {
  private readonly index: ReadonlyMap<string, { name: string; sedeCode: string | null; municipality: string }>;
  readonly catalog: GeoCatalog | null;

  private constructor(catalog: GeoCatalog | null, index: Map<string, { name: string; sedeCode: string | null; municipality: string }>) {
    this.catalog = catalog;
    this.index = index;
  }

  /** Normaliser without a partido catalog: province/comunidad only; every locality is UNRESOLVED. */
  static withoutCatalog(): GeoNormalizer {
    return new GeoNormalizer(null, new Map());
  }

  /** Validates the reviewed catalog and builds the deterministic index. Throws `GeoCatalogError`. */
  static fromCatalog(raw: unknown): GeoNormalizer {
    const parsed = GeoCatalogSchema.safeParse(raw);
    if (!parsed.success) {
      throw new GeoCatalogError('Geo catalog does not match the reviewed schema', {
        issues: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    const index = new Map<string, { name: string; sedeCode: string | null; municipality: string }>();
    for (const partido of parsed.data.partidos) {
      if (!PROVINCE_BY_CODE.has(partido.provinceIneCode)) {
        throw new GeoCatalogError('Unknown province code in catalog', { provinceIneCode: partido.provinceIneCode, partido: partido.name });
      }
      for (const municipality of partido.municipalities) {
        for (const key of municipalityKeys(municipality)) {
          const full = `${partido.provinceIneCode}|${key}`;
          const existing = index.get(full);
          if (existing && existing.name !== partido.name) {
            throw new GeoCatalogError('Municipality mapped to two partidos', { provinceIneCode: partido.provinceIneCode, municipality, a: existing.name, b: partido.name });
          }
          index.set(full, { name: partido.name, sedeCode: partido.sedeCode ?? null, municipality });
        }
      }
    }
    return new GeoNormalizer(parsed.data, index);
  }

  static provinceFromPostalCode(codigoPostal: string): ProvinceInfo | null {
    const digits = codigoPostal.replace(/\s/g, '');
    if (!/^\d{5}$/.test(digits)) return null;
    const row = PROVINCE_BY_CODE.get(digits.slice(0, 2));
    return row ? stripInfo(row) : null;
  }

  static provinceByName(name: string): ProvinceInfo | null {
    const row = PROVINCE_BY_NAME.get(normalizeForMatch(name));
    return row ? stripInfo(row) : null;
  }

  static comunidadByName(name: string): ComunidadInfo | null {
    const row = COMUNIDAD_BY_NAME.get(normalizeForMatch(name));
    return row ? { ineCode: row.ineCode, name: row.name } : null;
  }

  static comunidadOfProvince(province: ProvinceInfo): ComunidadInfo {
    const row = COMUNIDAD_BY_CODE.get(province.comunidadIneCode);
    if (!row) throw new GeoCatalogError('Province references an unknown comunidad', { province: province.ineCode });
    return { ineCode: row.ineCode, name: row.name };
  }

  /** Deterministic resolution. Never guesses: conflicting or missing data => UNRESOLVED. */
  resolve(input: GeoInput): GeoResolution {
    if (!input || typeof input !== 'object') throw new InvalidArgumentError('GeoInput required');
    const reasons: GeoReason[] = [];
    const unresolved = (extra: Partial<GeoResolution> = {}): GeoResolution => ({
      status: 'UNRESOLVED',
      comunidadAutonoma: null,
      provincia: null,
      localidad: null,
      partidoJudicial: null,
      ...extra,
      reasons,
    });

    const postal = input.codigoPostal?.trim() ?? '';
    const provinceName = input.provincia?.trim() ?? '';
    let fromPostal: ProvinceInfo | null = null;
    if (postal) {
      fromPostal = GeoNormalizer.provinceFromPostalCode(postal);
      if (!fromPostal) reasons.push(GeoReason.POSTAL_CODE_INVALID);
    }
    let fromName: ProvinceInfo | null = null;
    if (provinceName) {
      fromName = GeoNormalizer.provinceByName(provinceName);
      if (!fromName) reasons.push(GeoReason.PROVINCE_NAME_UNRECOGNISED);
    }
    if (fromPostal && fromName && fromPostal.ineCode !== fromName.ineCode) {
      reasons.push(GeoReason.PROVINCE_CONFLICT);
      return unresolved();
    }
    const provincia = fromPostal ?? fromName;
    if (!provincia) {
      reasons.push(GeoReason.PROVINCE_UNKNOWN);
      return unresolved();
    }
    const comunidad = GeoNormalizer.comunidadOfProvince(provincia);
    const comunidadName = input.comunidadAutonoma?.trim() ?? '';
    if (comunidadName) {
      const stated = GeoNormalizer.comunidadByName(comunidadName);
      if (!stated) reasons.push(GeoReason.COMUNIDAD_NAME_UNRECOGNISED);
      else if (stated.ineCode !== comunidad.ineCode) {
        reasons.push(GeoReason.COMUNIDAD_CONFLICT);
        return unresolved({ provincia, comunidadAutonoma: comunidad });
      }
    }

    const localidad = input.localidad?.trim() ?? '';
    if (!localidad) {
      reasons.push(GeoReason.LOCALITY_MISSING);
      return unresolved({ provincia, comunidadAutonoma: comunidad });
    }
    if (!this.catalog) {
      reasons.push(GeoReason.CATALOG_NOT_LOADED);
      return unresolved({ provincia, comunidadAutonoma: comunidad });
    }
    for (const key of municipalityKeys(localidad)) {
      const hit = this.index.get(`${provincia.ineCode}|${key}`);
      if (hit) {
        return {
          status: 'RESOLVED',
          comunidadAutonoma: comunidad,
          provincia,
          localidad: hit.municipality,
          partidoJudicial: { name: hit.name, sedeCode: hit.sedeCode },
          reasons,
        };
      }
    }
    reasons.push(GeoReason.MUNICIPALITY_NOT_IN_CATALOG);
    return unresolved({ provincia, comunidadAutonoma: comunidad });
  }
}
