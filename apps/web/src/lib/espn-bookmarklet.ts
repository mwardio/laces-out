export interface EspnBookmarkletConfiguration {
  readonly apiBaseUrl: string;
  readonly deviceToken: string;
  readonly leagueIds: readonly string[];
  readonly season: number;
}

export function currentEspnSeason(now = new Date()): number {
  const year = now.getFullYear();
  return now.getMonth() < 2 ? year - 1 : year;
}

export function createEspnBookmarklet(configuration: EspnBookmarkletConfiguration): string {
  const config = JSON.stringify({
    api: new URL(configuration.apiBaseUrl).origin,
    token: configuration.deviceToken,
    leagues: configuration.leagueIds,
    season: configuration.season,
  });

  return `javascript:(async()=>{const c=${config},a=m=>alert('Laces Out: '+m),v=['mSettings','mTeam','mRoster','mStandings','mMatchup'];try{if(location.hostname!=='fantasy.espn.com'){a('Open fantasy.espn.com, sign in, then run this bookmark again.');return}let n=0;for(const id of c.leagues){const u=new URL('https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/'+c.season+'/segments/0/leagues/'+id);v.forEach(x=>u.searchParams.append('view',x));const r=await fetch(u,{headers:{Accept:'application/json'},credentials:'include',cache:'no-store'});if(!r.ok)throw Error(r.status===401||r.status===403||r.status===404?'ESPN sign-in or league access is required for league '+id:'ESPN returned '+r.status+' for league '+id);const t=await r.text();if(new Blob([t]).size>5242880)throw Error('League '+id+' exceeded the safe transfer limit');const p=JSON.parse(t),j=JSON.stringify(p);if(String(p.id)!==id||!Array.isArray(p.teams)||!p.settings)throw Error('ESPN returned unexpected data for league '+id);const d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(j)),h=[...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,'0')).join('');const q=await fetch(c.api+'/v1/bridge/espn/snapshots',{method:'POST',headers:{Accept:'application/json',Authorization:'Bridge '+c.token,'Content-Type':'application/json'},body:JSON.stringify({schemaVersion:1,provider:'espn',authority:'browser-local',readOnly:true,leagueId:id,season:c.season,capturedAt:new Date().toISOString(),endpoint:u.toString(),checksumSha256:h,payload:p}),credentials:'omit',cache:'no-store'});if(!q.ok)throw Error(q.status===401||q.status===403?'This Laces Out sync button was revoked or expired':'Laces Out returned '+q.status);n++}a('synced '+n+' ESPN '+(n===1?'league':'leagues')+'. You can return to the locker room.')}catch(e){a(e&&e.message?e.message:'ESPN sync failed')}})()`;
}
