#!/bin/bash
input=$(cat)
echo '{"reason": "Blocked by test hook"}' >&2
exit 2
