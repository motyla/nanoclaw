
## Health and fitness data — strict rule

For ALL health, fitness, running, sleep, or sport-related questions: **only use the local SQLite database below**. Never attempt to access Strava, Garmin Connect, or any external service or API. You have no credentials for those services and no need for them — all the data is already in the DB.

## Garmin fitness data

The user's Garmin Connect data is in a local SQLite DB at /workspace/agent/garmin_data.db, refreshed by a daily sync.

Query it (read-only) by running:  bun /workspace/agent/query.js "SELECT ..."

Never invent numbers — only report what the query returns. If a query returns [], say there is no data for that range.

To refresh the data, the user sends the **/sync** command — it's handled on the host, outside you, and updates the DB in ~1 min. If the user asks you to sync (in natural language), tell them to send /sync. You can't run the sync yourself.

Units: distance is meters (/1000 = km), duration is seconds (/60 = min), average_speed is m/s (*3.6 = km/h). Running pace min/km = (duration/60)/(distance/1000). Timestamps are ISO strings — use date()/datetime() for time math.

Key tables: activity (workouts), sleep, heart_rate, stress, body_battery, respiration, steps, training_readiness, vo2_max, personal_record. Inspect columns with: bun /workspace/agent/query.js "SELECT * FROM activity LIMIT 1"

Known activity_type_key values: 'running', 'trail_running', 'treadmill_running', 'lap_swimming', 'strength_training', 'elliptical'. To discover all types present: SELECT DISTINCT activity_type_key FROM activity.

When the user asks about a specific sport, map it to the right key — e.g. "swim" or "swimming" → 'lap_swimming', "gym" or "weights" → 'strength_training'. Filter ORDER BY start_ts DESC LIMIT 1 for "last X". Don't mix activity types unless asked.

Example — last run:
bun /workspace/agent/query.js "SELECT activity_name, date(start_ts) day, round(distance/1000.0,2) km, round((duration/60.0)/(distance/1000.0),2) pace_min_km, round(average_hr) avg_hr FROM activity WHERE activity_type_key='running' ORDER BY start_ts DESC LIMIT 1"

Example — sleep last 7 nights:
bun /workspace/agent/query.js "SELECT date(start_ts) night, round(duration/3600.0,1) hours, overall_score FROM sleep ORDER BY start_ts DESC LIMIT 7"
