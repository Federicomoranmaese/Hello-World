#!/bin/bash
# Enlaza ~/.claude/instagram a la carpeta del repo, para que el perfil de voz,
# el historial (log.md), el plan y el swipe file de las skills ig-* se guarden
# con el repo y sobrevivan entre sesiones en la nube.
# No toca nada si ~/.claude/instagram ya es una carpeta con archivos.
REPO_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}/.claude/instagram"
LINK="$HOME/.claude/instagram"
mkdir -p "$REPO_DIR" "$HOME/.claude"
if [ -L "$LINK" ]; then
  ln -sfn "$REPO_DIR" "$LINK"
elif [ -d "$LINK" ] && [ -z "$(ls -A "$LINK")" ]; then
  rmdir "$LINK" && ln -s "$REPO_DIR" "$LINK"
elif [ ! -e "$LINK" ]; then
  ln -s "$REPO_DIR" "$LINK"
fi
exit 0
