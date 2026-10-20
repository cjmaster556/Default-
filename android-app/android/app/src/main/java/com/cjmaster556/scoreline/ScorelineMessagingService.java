package com.cjmaster556.scoreline;

import androidx.annotation.NonNull;
import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

// Receives every Firebase message. The server sends this app data-only messages, so the app
// itself draws the scoreboard notification (ScoreNotifier); the push plugin still gets the
// message and new tokens, as before.
public class ScorelineMessagingService extends MessagingService {

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        Map<String, String> data = message.getData();
        if (message.getNotification() == null && data.containsKey("title")) {
            ScoreNotifier.show(this, data, message.getMessageId());
        }
        super.onMessageReceived(message);
    }
}
