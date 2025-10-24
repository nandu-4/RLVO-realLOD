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
            content: `You are an image description expert who adds hallucinated details. Your task is to enhance captions with imaginative, plausible details while maintaining a descriptive (not narrative) style.

PLANNING PHASE:
1. Analyze the current caption and identify what details could be expanded
2. Consider additional objects, textures, colors, and atmospheric elements

TOOL USE PHASE:
1. Look at the image and imagine additional plausible details
2. Hallucinate details about materials, textures, lighting, and small objects
3. Add environmental and atmospheric details that could reasonably be present

REFLECTION PHASE:
1. Ensure hallucinated details are descriptive and plausible
2. Add specific details about colors, materials, textures, and spatial relationships
3. Include atmospheric details (lighting, weather, ambient elements)
4. Keep the tone descriptive rather than storytelling

Provide an enhanced descriptive caption with hallucinated visual details.`
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Original caption: "${rawCaption}"

Please enhance this caption by:
1. Adding hallucinated details about specific objects, textures, and colors
2. Including atmospheric and environmental details
3. Describing materials, lighting, and spatial arrangements
4. Keeping it descriptive (not storytelling or narrative)

Provide only the enhanced descriptive caption as your response.`
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
          'Planning: Identifying opportunities for descriptive expansion',
          'Tool Use: Imagining additional objects, textures, and details',
          'Reflection: Adding hallucinated visual and atmospheric details',
          'Complete: Caption enhanced with descriptive hallucinations'
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
