const { createClient } = require('@supabase/supabase-js')
const twilio = require('twilio')
const Anthropic = require('@anthropic-ai/sdk')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
const anthropic = new Anthropic()

const STATUS_MESSAGES = {
  ready:       (name, service, biz) => `Hi ${name}! Your ${service || 'service'} at ${biz} is complete and ready for pickup. Questions? Just reply here.`,
  in_progress: (name, service, biz) => `Hi ${name}! Quick update from ${biz} — your ${service || 'service'} is in progress. We'll text you when it's done.`,
  delayed:     (name, service, biz) => `Hi ${name}, ${biz} here. Heads up — your ${service || 'service'} is taking a bit longer than expected. We'll text you when it's ready.`,
  cancelled:   (name, service, biz) => `Hi ${name}, ${biz} here. We need to reschedule your ${service || 'appointment'}. Reply to set a new time.`,
}

module.exports = {
  name: 'status-updater',
  description: 'Sends automatic status updates to customers when job status changes',

  async handle(message, context) {
    const { customerName, customerPhone, status, businessName, serviceType, tone, clientId } = context

    let body = (STATUS_MESSAGES[status] || STATUS_MESSAGES.ready)(customerName, serviceType, businessName)

    if (tone === 'professional') {
      try {
        const result = await anthropic.messages.create({
          model: 'claude-haiku-4-5',
          max_tokens: 200,
          messages: [{
            role: 'user',
            content: `Rewrite this status update text to be more professional while keeping it under 160 chars and friendly. Original: "${body}"`,
          }],
        })
        if (result.content[0].type === 'text') body = result.content[0].text
      } catch {}
    }

    await twilioClient.messages.create({
      body,
      from: process.env.TWILIO_FROM_NUMBER,
      to: customerPhone,
    })

    await supabase.from('activity_log').insert({
      client_id: clientId,
      worker_type: 'status-updater',
      description: `Status update sent to ${customerName}: "${status}"`,
      created_at: new Date().toISOString(),
    })

    return { success: true, message: body }
  },
}
