const { createClient } = require('@supabase/supabase-js');
const { sendSMS } = require('../lib/twilio-client');
const aiClient = require('../lib/ai-client');

const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

const STATUS_MESSAGES = {
  ready:       (name, service, biz) => `Hi ${name}! Your ${service || 'service'} at ${biz} is complete and ready for pickup. Questions? Just reply here.`,
  in_progress: (name, service, biz) => `Hi ${name}! Quick update from ${biz} — your ${service || 'service'} is in progress. We'll text you when it's done.`,
  delayed:     (name, service, biz) => `Hi ${name}, ${biz} here. Heads up — your ${service || 'service'} is taking a bit longer than expected. We'll text you when it's ready.`,
  cancelled:   (name, service, biz) => `Hi ${name}, ${biz} here. We need to reschedule your ${service || 'appointment'}. Reply to set a new time.`,
};

module.exports = {
  name: 'status-updater',
  description: 'Sends automatic status updates to customers when job status changes',

  async handle(message, context) {
    const { customerName, customerPhone, status, businessName, serviceType, tone, clientId } = context;

    let body = (STATUS_MESSAGES[status] || STATUS_MESSAGES.ready)(customerName, serviceType, businessName);

    if (tone === 'professional') {
      try {
        body = await aiClient.call({
          modelString: 'groq/llama-3.3-70b-versatile',
          systemPrompt: 'You rewrite SMS status updates to be more professional while keeping them under 160 chars and friendly. Reply with only the rewritten message.',
          messages: [{ role: 'user', content: `Rewrite this status update: "${body}"` }],
          maxTokens: 200,
          _workerName: 'status-updater',
        });
      } catch {}
    }

    await sendSMS({
      body,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: customerPhone,
      clientSlug: context.clientSlug,
      clientTimezone: context.clientTimezone,
    });

    await supabase.from('activity_log').insert({
      client_id:   clientId,
      worker_id:   'status-updater',
      worker_name: 'status-updater',
      action:      'message_sent',
      outcome:     'ok',
      message:     `Status update sent to ${customerName}: "${status}"`,
      created_at:  new Date().toISOString(),
    });

    return { success: true, message: body };
  },
};
