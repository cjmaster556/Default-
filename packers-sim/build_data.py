#!/usr/bin/env python3
"""Fetch the nflverse schedule and write data.js (games + Elo ratings).
Usage: python3 build_data.py [path/to/games.csv]   (downloads if omitted)"""
import csv, io, json, sys, urllib.request, datetime
SEASON = 2026
URL = "https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv"
DIV = {
 "AFC East":["BUF","MIA","NE","NYJ"],"AFC North":["BAL","CIN","CLE","PIT"],
 "AFC South":["HOU","IND","JAX","TEN"],"AFC West":["DEN","KC","LV","LAC"],
 "NFC East":["DAL","NYG","PHI","WAS"],"NFC North":["CHI","DET","GB","MIN"],
 "NFC South":["ATL","CAR","NO","TB"],"NFC West":["ARI","LA","SEA","SF"]}
FIX = {"LAR":"LA","OAK":"LV","SD":"LAC","STL":"LA","WSH":"WAS"}
txt = open(sys.argv[1]).read() if len(sys.argv)>1 else urllib.request.urlopen(URL).read().decode()
rows = [r for r in csv.DictReader(io.StringIO(txt)) if r["game_type"]]
for r in rows:
    r["away_team"]=FIX.get(r["away_team"],r["away_team"]); r["home_team"]=FIX.get(r["home_team"],r["home_team"])
teams = {t for v in DIV.values() for t in v}
elo = {t:1500.0 for t in teams}
cur_season = None
def f(x): return None if x in ("","NA") else float(x)
for r in sorted([r for r in rows if int(r["season"])>=2021], key=lambda r:(r["gameday"],r["game_id"])):
    s=int(r["season"])
    if s!=cur_season:
        if cur_season is not None:
            for t in elo: elo[t]=elo[t]*0.75+1500*0.25
        cur_season=s
    a,h=r["away_team"],r["home_team"]; as_,hs=f(r["away_score"]),f(r["home_score"])
    if as_ is None or hs is None or a not in teams or h not in teams: continue
    exp=1/(1+10**(-(elo[h]+48-elo[a])/400))
    act=1 if hs>as_ else 0 if hs<as_ else .5
    mov=abs(hs-as_); ed=elo[h]+48-elo[a]
    if hs<as_: ed=-ed
    mult=((mov+3)**.8)/(7.5+.006*ed) if mov else 1
    d=20*mult*(act-exp); elo[h]+=d; elo[a]-=d
games=[]
for r in rows:
    if int(r["season"])!=SEASON or r["game_type"]!="REG": continue
    games.append({"w":int(r["week"]),"d":r["gameday"],"a":r["away_team"],"h":r["home_team"],
                  "as":f(r["away_score"]),"hs":f(r["home_score"])})
games.sort(key=lambda g:(g["w"],g["d"]))
out={"season":SEASON,"updated":datetime.date.today().isoformat(),"divisions":DIV,
     "elo":{t:round(v,1) for t,v in elo.items()},"games":games}
open("data.js","w").write("window.NFL_DATA="+json.dumps(out,separators=(",",":"))+";\n")
played=sum(g["as"] is not None for g in games)
print(f"{len(games)} games, {played} played; top Elo:",sorted(elo.items(),key=lambda x:-x[1])[:5])
