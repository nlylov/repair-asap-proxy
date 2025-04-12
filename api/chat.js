
const { OpenAI } = require('openai');

const OPENAI_API_KEY = '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';
const ASSISTANT_ID = 'asst_oMI1gmdS9GXwWOmnvglS1DFm';

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { message, conversationId } = req.body;
    let threadId = conversationId;
    if (!threadId) {
      const thread = await openai.beta.threads.create();
      threadId = thread.id;
    }
    await openai.beta.threads.messages.create(threadId, {
      role: 'user',
      content: message,
    });

    const run = await openai.beta.threads.runs.create(threadId, {
      assistant_id: ASSISTANT_ID,
    });

    let runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
    while (runStatus.status !== 'completed') {
      await new Promise(resolve => setTimeout(resolve, 1000));
      runStatus = await openai.beta.threads.runs.retrieve(threadId, run.id);
      if (runStatus.status === 'failed') {
        throw new Error('Failed to process message');
      }
    }

    const messages = await openai.beta.threads.messages.list(threadId);
    const assistantResponse = messages.data.find(msg => msg.role === 'assistant' && msg.run_id === run.id);

    res.json({ response: assistantResponse.content[0].text.value, conversationId: threadId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};
