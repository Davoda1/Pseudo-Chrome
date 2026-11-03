'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ResEdit = require(process.env.RESEDIT_MODULE_PATH || 'resedit');
const [input, output, icon, version = '1.0.0'] = process.argv.slice(2);
if (!input || !output || !icon) throw new Error('Usage: node scripts/brand-windows.cjs input.exe output.exe icon.ico [version]');
const exe = ResEdit.NtExecutable.from(fs.readFileSync(input), {ignoreCert: true});
const resources = ResEdit.NtExecutableResource.from(exe);
const iconData = ResEdit.Data.IconFile.from(fs.readFileSync(icon));
const groups = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries);
for (const group of groups) {
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang, iconData.icons.map(item => item.data));
}
if (!groups.length) ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, 1, 1033, iconData.icons.map(item => item.data));
const parts = version.split('.').map(Number);
for (const info of ResEdit.Resource.VersionInfo.fromEntries(resources.entries)) {
  info.setFileVersion(parts[0], parts[1], parts[2], 0, 1033);
  info.setProductVersion(parts[0], parts[1], parts[2], 0, 1033);
  info.setStringValues({lang:1033,codepage:1200}, {
    CompanyName:'', FileDescription:'Pseudo-Chrome website demonstration tool',
    ProductName:'Pseudo-Chrome', InternalName:'Pseudo-Chrome', OriginalFilename:'Pseudo-Chrome.exe',
    LegalCopyright:'Copyright davoda1', Comments:'Local website demonstration utility. GNU AGPLv3. Built with Electron.'
  });
  info.outputToResourceEntries(resources.entries);
}
resources.outputResource(exe);
fs.mkdirSync(path.dirname(path.resolve(output)), {recursive:true});
fs.writeFileSync(output, Buffer.from(exe.generate()));
const check = ResEdit.NtExecutableResource.from(ResEdit.NtExecutable.from(fs.readFileSync(output)));
if (!ResEdit.Resource.IconGroupEntry.fromEntries(check.entries).length) throw new Error('Output has no icon group');
console.log(JSON.stringify({output,iconGroups:groups.length,version}));
