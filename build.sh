#!/bin/bash

zip export_lautman_$(cat manifest.json | jq '.version' -r).zip *.json *.js *.css *.png
