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
    const { cause, duration, timestamp } = await req.json();
    
    console.log('Critical anomaly logged:', { cause, duration, timestamp });

    // In a real implementation, you would insert this into a database table
    // For now, we're just logging it
    // Example:
    // const { error } = await supabase
    //   .from('anomaly_logs')
    //   .insert({ cause, duration, timestamp });

    return new Response(
      JSON.stringify({ success: true, message: 'Anomaly logged successfully' }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );

  } catch (error) {
    console.error('Error logging anomaly:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { 
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      }
    );
  }
});
