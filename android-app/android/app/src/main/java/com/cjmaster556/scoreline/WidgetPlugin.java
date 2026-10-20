package com.cjmaster556.scoreline;

import android.content.Context;
import com.getcapacitor.JSArray;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Lets the web app tell the home screen widget which teams are followed (as "league:teamId" keys).
@CapacitorPlugin(name = "ScorelineWidget")
public class WidgetPlugin extends Plugin {

    @PluginMethod
    public void setTeams(PluginCall call) {
        JSArray teams = call.getArray("teams", new JSArray());
        getContext().getSharedPreferences(ScoreWidget.PREFS, Context.MODE_PRIVATE).edit().putString("teams", teams.toString()).apply();
        ScoreWidget.refresh(getContext());
        call.resolve();
    }
}
