#!/usr/bin/env bash
# Sets the Modeller academic license key inside the active tarantino
# micromamba env. Modeller reads this from <env>/lib/modeller-*/modlib/modeller/config.py.
#
# Usage:
#   micromamba activate tarantino
#   KEY=<your-license-key> bash scripts/set-modeller-key.sh
#
# Or with an explicit env prefix:
#   KEY=<your-license-key> bash scripts/set-modeller-key.sh /opt/conda/envs/tarantino
#
# Get a free academic license at https://salilab.org/modeller/registration.html

set -euo pipefail

if [ -z "${KEY:-}" ]; then
  echo "error: KEY env var is required."
  echo "       Register at https://salilab.org/modeller/registration.html"
  echo "       Then: KEY=<your-license-key> bash scripts/set-modeller-key.sh"
  exit 1
fi

PREFIX="${1:-${CONDA_PREFIX:-${MAMBA_ROOT_PREFIX:-}}}"
if [ -z "${PREFIX}" ]; then
  echo "error: no env prefix found. Activate the tarantino env first or pass it as an argument."
  echo "       e.g. bash scripts/set-modeller-key.sh /opt/conda/envs/tarantino"
  exit 1
fi

# Find Modeller config.py inside the env
CONFIG=$(find "${PREFIX}/lib" -maxdepth 4 -path "*/modeller*/modlib/modeller/config.py" 2>/dev/null | head -1)

if [ -z "${CONFIG}" ]; then
  echo "error: could not find modeller/config.py under ${PREFIX}/lib"
  echo "       is Modeller installed in this env? (try: micromamba list -n tarantino | grep modeller)"
  exit 1
fi

echo "Found Modeller config: ${CONFIG}"

# Replace or insert the license line. Modeller's default file has:
#   license = r'XXXXXX'
# (or sometimes a placeholder). We sed-replace it; if no license line exists,
# we append one.
if grep -q '^license\s*=' "${CONFIG}"; then
  # Replace existing license line
  sed -i.bak "s|^license\s*=.*|license = r'${KEY}'|" "${CONFIG}"
else
  printf "\nlicense = r'%s'\n" "${KEY}" >> "${CONFIG}"
fi

echo "Modeller license set to '${KEY}'."
echo "Backup of previous config saved to ${CONFIG}.bak (if a license line existed)."
