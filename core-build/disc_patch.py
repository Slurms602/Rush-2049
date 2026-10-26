#!/usr/bin/env python3
"""Let the page replace disc sectors (for mods), on core/imgread/common.cpp (idempotent).

fly_disc_patch_add(fad, count, data): from now on, reads of these 2048-byte sectors return
  `data` instead of what the disc image holds. Every player installs the same patches before
  the game reads the disc, so lockstep stays in sync. Works for any image format (GDI, CHD, CDI).
fly_disc_patch_clear(): drop all patches.
fly_disc_read(fad, count, dst): read the image as stored, ignoring patches, so the page can
  build its patches (e.g. directory changes) from the player's own disc.
"""
import sys

path = sys.argv[1]
src = open(path, encoding="utf-8").read()
if "fly_disc_patch" in src:
    print("already applied")
    sys.exit(0)

anchor = "u32 libGDR_ReadSector(u8 *buff, u32 startSector, u32 sectorCount, u32 sectorSize, bool stopOnMiss)\n{\n\tif (disc != nullptr)\n\t\treturn disc->ReadSectors(startSector, sectorCount, buff, sectorSize, stopOnMiss);\n"
assert src.count(anchor) == 1, "libGDR_ReadSector anchor not found"
src = src.replace(anchor, '''#ifdef __EMSCRIPTEN__
#include <emscripten.h>
#include <unordered_map>
#include <vector>
static std::unordered_map<u32, std::vector<u8>> fly_disc_patch;   // FAD -> 2048 bytes of user data
extern "C" EMSCRIPTEN_KEEPALIVE void fly_disc_patch_clear() { fly_disc_patch.clear(); }
extern "C" EMSCRIPTEN_KEEPALIVE void fly_disc_patch_add(u32 fad, u32 count, const u8 *data)
{
	for (u32 i = 0; i < count; i++)
		fly_disc_patch[fad + i].assign(data + i * 2048, data + (i + 1) * 2048);
}
extern "C" EMSCRIPTEN_KEEPALIVE u32 fly_disc_read(u32 fad, u32 count, u8 *dst)
{
	return disc != nullptr ? disc->ReadSectors(fad, count, dst, 2048) : 0;
}
#endif

u32 libGDR_ReadSector(u8 *buff, u32 startSector, u32 sectorCount, u32 sectorSize, bool stopOnMiss)
{
	if (disc != nullptr)
	{
		u32 n = disc->ReadSectors(startSector, sectorCount, buff, sectorSize, stopOnMiss);
#ifdef __EMSCRIPTEN__
		if (sectorSize == 2048 && !fly_disc_patch.empty())
			for (u32 i = 0; i < n; i++)
			{
				auto it = fly_disc_patch.find(startSector + i);
				if (it != fly_disc_patch.end())
					memcpy(buff + i * 2048, it->second.data(), 2048);
			}
#endif
		return n;
	}
''')
open(path, "w", encoding="utf-8").write(src)
print("applied")
