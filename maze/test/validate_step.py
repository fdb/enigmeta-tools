"""Load exported STEP files in OpenCASCADE (via gmsh) and report bodies and volume.

    python3 -m pip install gmsh
    python3 maze/test/validate_step.py /tmp/out/*.step
"""
import sys

import gmsh

gmsh.initialize()
gmsh.option.setNumber("General.Terminal", 0)
ok = True
for path in sys.argv[1:]:
    gmsh.clear()
    gmsh.model.occ.importShapes(path)
    gmsh.model.occ.synchronize()
    vols = gmsh.model.getEntities(3)
    total = sum(gmsh.model.occ.getMass(3, tag) for _, tag in vols)
    if not vols or total <= 0:
        ok = False
    print(f"{path}: {len(vols)} solid(s), {total:.1f} mm³")
gmsh.finalize()
sys.exit(0 if ok else 1)
