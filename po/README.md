# Translating Plyph

Plyph follows the GNOME session language. English is used when a translation is missing. GNU gettext tools (`xgettext`, `msginit`, `msgmerge`, and `msgfmt`) are needed for translation work and packaging translations.

1. Refresh the template from the repository root:

   ```sh
   sh po/update.sh
   ```

2. Create a language file, replacing `de` with your locale code:

   ```sh
   msginit --input=po/plyph.pot --locale=de --output-file=po/de.po
   ```

   For an existing translation, merge the latest template instead:

   ```sh
   msgmerge --update --backup=none po/de.po po/plyph.pot
   ```

3. Translate `msgstr` entries using a text editor, Gtranslator, or Poedit. Update the translator details and plural rules in the header. Keep the English `msgid` entries unchanged.

4. Validate the translation:

   ```sh
   msgfmt --check --check-format --output-file=/tmp/plyph-de.mo po/de.po
   ```

5. Package using the command in the main README. Its `--podir=po` option compiles catalogs into `locale/<language>/LC_MESSAGES/plyph.mo`. Only compiled catalogs go into the upload ZIP; translation sources and build scripts stay in the repository.

Install the ZIP and log out/in to test Shell text. Reopen preferences to test settings text. Use your translated session language and check long labels and right-to-left layouts where applicable. Submit the `.po` file in your contribution; do not commit generated `.mo` files.

## Placeholders and user data

Keep `%s` and `%d` placeholders. You can reorder them using numbered forms: `%2$s` uses the second value and `%1$s` uses the first. Use `%%` for a literal percent sign in a formatted message. Preserve variable names such as `${selection}`, `${language}`, `${tone}`, and `${style}`, JSON keys, model IDs, and HTTP header names in explanatory text.

Brand names stay unchanged. Saved provider names, user-defined action names and prompts, personal context, and AI instructions are not translated or rewritten. Translations cover interface text and Plyph-generated errors; responses and errors supplied by an external provider remain as received.

## For developers

Import `_` and `format` from `i18n.js` (use `../i18n.js` inside `shell/`). Use complete messages with placeholders, for example `format(_('Could not connect to %s.'), providerName)`. Do not translate IDs, settings keys, API parameters, or AI prompts. Use `N_` to mark static label tables without translating them before GNOME initializes the domain, then call `_` when displaying the labels. Use `ngettext` for messages whose wording depends on a count. Regenerate `po/plyph.pot` after changing messages.
