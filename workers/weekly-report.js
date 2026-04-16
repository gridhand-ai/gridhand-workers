const { createClient } = require('@supabase/supabase-js');
const twilio = require('twilio');

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Returns { report: string, activityCount: number } — count reused by caller, no second query
async function generateWeeklyReport(clientId, businessName) {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: activities } = await supabase
    .from('activity_log')
    .select('worker, action, result, created_at')
    .eq('client_id', clientId)
    .gte('created_at', weekAgo)
    .order('created_at', { ascending: false });

  if (!activities?.length) {
    return {
      report: `${businessName} Weekly Report\n\nNo activity this week. Your workers are standing by.`,
      activityCount: 0,
    };
  }

  const workerCounts = {};
  activities.forEach(a => {
    workerCounts[a.worker] = (workerCounts[a.worker] || 0) + 1;
  });
  const topWorker = Object.entries(workerCounts).sort((a, b) => b[1] - a[1])[0];

  const dayCounts = {};
  activities.forEach(a => {
    const day = new Date(a.created_at).toLocaleDateString('en-US', { weekday: 'long' });
    dayCounts[day] = (dayCounts[day] || 0) + 1;
  });
  const busiestDay = Object.entries(dayCounts).sort((a, b) => b[1] - a[1])[0];

  return {
    report: `${businessName} — Weekly Report\n\n${activities.length} tasks completed\nTop worker: ${topWorker[0]} (${topWorker[1]} tasks)\nBusiest day: ${busiestDay[0]}\n\nYour AI team handled everything while you focused on your work.\n\n— GRIDHAND AI`,
    activityCount: activities.length,
  };
}

module.exports = {
  name: 'weekly-report',
  description: 'Sends weekly performance summary every Monday',

  async run(clientId, businessName, phoneNumber) {
    const { report, activityCount } = await generateWeeklyReport(clientId, businessName);

    await twilioClient.messages.create({
      body: report,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phoneNumber,
    });

    // Activity count already came from generateWeeklyReport — no second query
    await supabase.from('activity_log').insert({
      client_id: clientId,
      worker: 'weekly-report',
      action: 'task_completed',
      result: `Weekly report sent: ${activityCount} tasks this week`,
      created_at: new Date().toISOString(),
    });

    return { success: true, report };
  },
};
