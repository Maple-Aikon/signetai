#!/bin/bash
# Reads stdin (hook input JSON), outputs allow decision
input=$(cat)
echo '{"decision": "allow", "reason": null, "inject": null, "data": {}}'
exit 0
