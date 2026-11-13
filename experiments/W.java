import java.nio.file.*; import java.util.*;
public class W { static List<Map<String,Object>> recs=new ArrayList<>();
 public static void main(String[] a) throws Exception {
  for(String l: Files.readAllLines(Paths.get(a[0]))){ Map<String,Object> m=new HashMap<>();
   String body=l.substring(1,l.length()-1); int i=0;
   while(i<body.length()){ int k1=body.indexOf('"',i), k2=body.indexOf('"',k1+1); String k=body.substring(k1+1,k2); int v=k2+2; Object val; int end;
     if(body.charAt(v)=='"'){ end=body.indexOf('"',v+1); val=body.substring(v+1,end); end++; } else { end=body.indexOf(',',v); if(end<0) end=body.length(); val=Long.parseLong(body.substring(v,end)); }
     m.put(k,val); i=end+1; }
   recs.add(m);} System.out.println("ready"); Thread.sleep(600000);} }
