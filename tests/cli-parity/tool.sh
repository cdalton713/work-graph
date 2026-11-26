#!/bin/sh
echo "${0##*/} $*" >> "$HOME/calls"
case "${0##*/} $*" in
  "git diff --name-only main...HEAD")
    printf '%s\n' src/new README.md unexpected.txt
    ;;
  *) exit 1 ;;
esac
