/**
 * Read profile-backed settings from a Host plugin.
 *
 * Upstream 0.1.7 replaced the abstract `ctx.settings` seam — a file-backed
 * provider with `register(namespace, schema, …)`, `get(namespace)` and
 * `watch(listener)`, whose document was `$DSH_HOME/settings.yaml` — with
 * `SettingsForms` (`@deepseek-ai/dsh-settings`). In the new model:
 *
 * - the settings **namespace is a profile entry id** (`ui-theme`, `locale`,
 *   our own `desktop-shell`), not an arbitrary string;
 * - the storage is the entry's `config` in the profile patch, projected through
 *   the volatile fields of the plugin's `Config` schema, and {@link
 *   SettingsFormDescriptor.value} is the **plain** projection (upstream resolves
 *   every reference before reporting it);
 * - reads go through `describe()`, and live changes arrive as the
 *   `settings/document-updated` event (namespace, revision).
 *
 * `settings.yaml` is retired: upstream imports its sections once on boot and
 * renames the document. A `dsh-desktop` section therefore cannot be imported
 * (it is not an entry id), which is why the launcher treats the legacy file as
 * a one-time fallback for its startup port (see `profile.ts`).
 * @module dsh-plugin-desktop/settings-forms
 */

/** One projected configuration form, as `SettingsForms.describe()` reports it. */
export interface SettingsFormDescriptor {
  /** Profile entry id this form belongs to. */
  readonly ns: string
  /** Projected (plain) live value. */
  readonly value: unknown
  /** Monotonic revision of this form within the running process. */
  readonly revision: number
}

/** The settings surface this package consumes (structural, for focused tests). */
export interface SettingsFormsReader {
  /** Read every active form; entries without volatile fields are omitted. */
  describe(): readonly SettingsFormDescriptor[]
}

/**
 * Read the live value of one profile entry's configuration form.
 * @param settings - the active settings service (may be absent in smokes).
 * @param ns - profile entry id.
 * @returns the projected value, or `undefined` when the entry is not composed.
 */
export function readSettingsNamespace<T>(
  settings: SettingsFormsReader | undefined,
  ns: string,
): T | undefined {
  const row = settings?.describe().find(descriptor => descriptor.ns === ns)
  return row === undefined ? undefined : row.value as T
}
