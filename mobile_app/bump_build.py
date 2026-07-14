#!/usr/bin/env python3
"""
bump_build.py — auto-increments CURRENT_PROJECT_VERSION in project.pbxproj
Usage: python3 bump_build.py
Run from anywhere inside the project, or pass path as argument.
"""
import re
import sys
import os

# Find project.pbxproj
if len(sys.argv) > 1:
    pbxproj = sys.argv[1]
else:
    # Auto-discover from script location or cwd
    candidates = [
        'ios/App/App.xcodeproj/project.pbxproj',
        '../ios/App/App.xcodeproj/project.pbxproj',
        '../../ios/App/App.xcodeproj/project.pbxproj',
    ]
    pbxproj = next((p for p in candidates if os.path.exists(p)), None)
    if not pbxproj:
        print('ERROR: Could not find project.pbxproj. Pass the path as an argument.')
        sys.exit(1)

pbxproj = os.path.abspath(pbxproj)
print(f'Reading: {pbxproj}')

with open(pbxproj, 'r', encoding='utf-8') as f:
    content = f.read()

# Find current build number
match = re.search(r'CURRENT_PROJECT_VERSION\s*=\s*(\d+)\s*;', content)
if not match:
    print('ERROR: CURRENT_PROJECT_VERSION not found in project.pbxproj')
    sys.exit(1)

old_version = int(match.group(1))
new_version = old_version + 1

# Replace ALL occurrences (Debug + Release configs both need updating)
new_content = re.sub(
    r'(CURRENT_PROJECT_VERSION\s*=\s*)\d+(\s*;)',
    lambda m: f'{m.group(1)}{new_version}{m.group(2)}',
    content
)

count = len(re.findall(r'CURRENT_PROJECT_VERSION', new_content))

with open(pbxproj, 'w', encoding='utf-8') as f:
    f.write(new_content)

print(f'✓ CURRENT_PROJECT_VERSION: {old_version} → {new_version}  ({count} occurrences updated)')
