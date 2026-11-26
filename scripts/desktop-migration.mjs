import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

export async function checkMigration({root,launch,api,closeApp,baseline}) {
  const profile=path.join(root,"migration");
  const source=path.join(profile,"electron-app-data","Electron");
  await fs.mkdir(source,{recursive:true});
  // Use only storage written by the previous React/Electron renderer when a
  // comparison profile is supplied. Other Chromium profile data is irrelevant.
  if(baseline) await fs.cp(path.join(baseline,"electron-app-data","Electron","Local Storage"),path.join(source,"Local Storage"),{recursive:true});
  const stamp=1750000000000;
  const project={id:"saved-project",directory:root,name:"Original project",notes:"Saved notes",pinned:true,bookmarked:false,createdAt:stamp,lastSeen:stamp};
  const cli=JSON.parse(await fs.readFile(new URL("../tests/fixtures/cli-inventory.json",import.meta.url),"utf8"));
  const legacy={
    "settings.json":{notifications:false,scanIntervalMs:3456,closeToTray:true},
    "projects.json":{state:{schemaVersion:1,projects:[project],recentlyStopped:[],activity:[],lastObserved:[],associations:{},legacyNotes:[],legacyNotesMigrated:false}},
    "port-notes.json":{notes:{"49377":"Unassigned historical note"}},
    "stats.json":{portCounts:{"49377":200}},
    "clis.json":{schemaVersion:2,inventory:cli,lastScanStatus:"complete",scanAttempts:[],uninstallAudits:[]},
    "recent-scripts.json":{scripts:[{type:"ahk",scriptPath:path.join(root,"fixture.ahk"),scriptName:"fixture.ahk",firstSeen:stamp,lastUsed:stamp,useCount:4}]},
  };
  for(const [name,record] of Object.entries(legacy)) await fs.writeFile(path.join(source,name),JSON.stringify(record));
  await launch(profile);
  assert.equal((await api("getSettings")).scanIntervalMs,3456);
  assert.equal((await api("getSettings")).notifyOnStart,false);
  const snapshot=await api("getProjects");
  const migrated=snapshot.projects.find(p=>p.id===project.id);
  assert.equal(migrated.notes,project.notes); assert.equal(migrated.pinned,true); assert.equal(migrated.ignored,false);
  const note=snapshot.legacyNotes.find(n=>n.port==="49377");
  assert.equal(note.text,"Unassigned historical note");
  const edited=await api("attachLegacyNote",{noteId:note.id,projectId:project.id});
  assert(edited.projects.find(p=>p.id===project.id).notes.includes(note.text));
  assert((await api("getStats")).portCounts["49377"]>=200);
  assert.equal((await api("getCliInventory")).revision,cli.revision);
  assert((await api("getRecentScripts")).some(s=>s.scriptName==="fixture.ahk" && s.useCount===4));
  if(baseline) {
    const preferences=JSON.parse(await fs.readFile(path.join(profile,"tauri-app-data","renderer-preferences.json"),"utf8"));
    assert.equal(preferences["dashboard:activeTab"],"servers");
  }
  await closeApp();
  for(const [name,record] of Object.entries(legacy)) assert.equal(await fs.readFile(path.join(source,name),"utf8"),JSON.stringify(record));
  await launch(profile);
  const after=await api("getProjects");
  assert.equal(after.legacyNotes.filter(n=>n.id===note.id).length,0);
  assert(after.projects.find(p=>p.id===project.id).notes.includes(note.text));
  await closeApp();
}
