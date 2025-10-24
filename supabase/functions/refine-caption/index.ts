import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { image, rawCaption } = await req.json();
    
    if (!image || !rawCaption) {
      throw new Error('Image and rawCaption are required');
    }

    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    if (!LOVABLE_API_KEY) {
      throw new Error('LOVABLE_API_KEY is not configured');
    }

    console.log('Refining caption with agentic workflow...');
    console.log('Original caption:', rawCaption);

    // Agentic refinement workflow with planning, tool use, and reflection
    const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${LOVABLE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'google/gemini-2.5-flash',
        messages: [
          {
            role: 'system',
            content: `You are a creative storytelling and image analysis expert. Your task is to enhance captions by adding imaginative, hallucinated details that go beyond what's literally visible.

PLANNING PHASE:
1. Analyze the current caption and identify opportunities for creative expansion
2. Consider the mood, context, and potential backstory of the scene

TOOL USE PHASE:
1. Look at the image and let your imagination expand on what you see
2. Hallucinate plausible details about emotions, thoughts, relationships, and atmosphere
3. Add creative interpretations of the setting, time period, and circumstances

REFLECTION PHASE:
1. Ensure the hallucinated details feel natural and enhance the narrative
2. Add vivid sensory descriptions (sounds, smells, textures, feelings)
3. Expand on character motivations, relationships, and unspoken elements
4. Create a richer, more engaging caption with imaginative details

Provide a refined, creative caption with hallucinated details that tell a compelling story.`
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Original caption: "${rawCaption}"

Please enhance this caption by:
1. Adding imaginative, hallucinated details about emotions, atmosphere, and context
2. Expanding on the backstory and relationships you imagine
3. Including sensory details and creative interpretations
4. Making it more vivid and engaging with creative storytelling

Provide only the enhanced, creative caption as your response.`
              },
              {
                type: 'image_url',
                image_url: {
                  url: image
                }
              }
            ]
          }
        ],
        max_tokens: 200
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('AI gateway error:', response.status, errorText);
      throw new Error(`AI gateway error: ${response.status}`);
    }

    const data = await response.json();
    const refinedCaption = data.choices[0].message.content;

    console.log('Refined caption:', refinedCaption);

    return new Response(
      JSON.stringify({ 
        refinedCaption,
        logs: [
          'Planning: Identifying opportunities for creative expansion',
          'Tool Use: Imagining emotions, atmosphere, and hidden context',
          'Reflection: Adding hallucinated sensory and narrative details',
          'Complete: Caption enhanced with creative storytelling'
        ]
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );

  } catch (error) {
    console.error('Error in refine-caption:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  }
});
