#!/usr/bin/env node
// `pnpm init:profile` is replaced by `brand create` (storage foundation, design section 6).
//
// This used to copy profiles/example/ into profiles/<slug>/. A brand now lives in storage, so this
// script writes nothing at all: no profile folder and no denylist entry. It only says where to go.
// It goes away with the rest of the folder tooling (design section 13, S12).

const NOTICE = `pnpm init:profile ya no crea carpetas de perfil.

Una marca nueva se da de alta en storage:

  pnpm --filter @personal-brand/storage brand create <marca> --name "<nombre>" --owner-opt-in <marca>

(requiere DATABASE_URL, y BRAND_OWNER_OPT_IN=<marca> en el entorno: el alta de una marca real es decisión del dueño).

Después, agrega a mano el slug, el dominio, el @handle y la ciudad de la marca a
scripts/brand-denylist.local.txt (ignorado por git) y revisa el árbol con:

  python3 scripts/validate_commit_guardian.py --scan

Para probar el motor sin marca real usa los perfiles ficticios profiles/example*.
`;

// `--help` just prints the pointer (exit 0). Any other run exits 2 ON PURPOSE: automation that used to
// create a profile through this script must fail loudly, not carry on believing a folder exists.
const asksHelp = process.argv.slice(2).some((a) => a === "--help" || a === "-h");
(asksHelp ? console.log : console.error)(NOTICE);
process.exit(asksHelp ? 0 : 2);
