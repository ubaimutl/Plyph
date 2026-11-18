#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
xgettext --language=JavaScript --from-code=UTF-8 \
    --keyword=_ --keyword=N_ --keyword=ngettext:1,2 \
    --flag=format:1:javascript-format \
    --package-name=Plyph --package-version=1 \
    --msgid-bugs-address=https://github.com/ubaimutl/Plyph/issues \
    --copyright-holder='Plyph contributors' \
    --output=po/plyph.pot --files-from=po/POTFILES.in
