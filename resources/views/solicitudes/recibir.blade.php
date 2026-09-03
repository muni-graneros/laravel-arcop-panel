@extends(config('arcop-panel.layout'))

@section('arcop-titulo', 'Datos de la solicitud · '.config('arcop-panel.titulo'))

@section('arcop')
    @include('arcop-panel::partes.avisos')

    <h1>Recibir una solicitud: paso 2 de 2</h1>
    <p class="arcop-guia">Titular: <strong>{{ $etiquetaTitular }}</strong>
        (<a href="{{ route('arcop.solicitudes.buscar') }}">buscar a otra persona</a>)</p>

    @if (config('arcop-panel.ayuda_del_adoptante.ruta') && config('arcop-panel.ayuda_del_adoptante.texto'))
        {{-- El sistema puede negarse a tramitar por algo que solo él resuelve.
             Este enlace es para que el funcionario tenga adónde ir cuando eso
             pasa, en vez de quedarse con la negativa en la mano. --}}
        <p class="arcop-guia">
            <a href="{{ route(config('arcop-panel.ayuda_del_adoptante.ruta'), $titular->getKey()) }}">
                {{ config('arcop-panel.ayuda_del_adoptante.texto') }}
            </a>
        </p>
    @endif

    {{-- Cada error va también junto a SU campo (aria-invalid + aria-describedby),
         no solo en el resumen de arriba: WCAG 3.3.1 y 3.3.3. --}}
    <form method="POST" action="{{ route('arcop.solicitudes.store') }}" class="arcop-formulario"
          enctype="multipart/form-data">
        @csrf
        {{-- La referencia opaca de la búsqueda, no la clave del titular: el
             paso 3 solo recibe solicitudes para alguien elegido de una
             búsqueda de esta sesión. --}}
        <input type="hidden" name="titular" value="{{ $referencia }}">

        <div class="arcop-campo">
            <label for="tipo">Derecho que ejerce</label>
            <select id="tipo" name="tipo" required
                    @error('tipo') aria-invalid="true" aria-describedby="tipo-error" @enderror>
                @foreach ($tipos as $tipo)
                    <option value="{{ $tipo->value }}" @selected(old('tipo') === $tipo->value)>
                        {{ $tipo->etiqueta() }}
                    </option>
                @endforeach
            </select>
            @include('arcop-panel::partes.error', ['campo' => 'tipo'])
        </div>

        <div class="arcop-campo">
            <label for="solicitante">Quién ejerce el derecho</label>
            <select id="solicitante" name="solicitante" required
                    aria-describedby="solicitante-ayuda@error('solicitante') solicitante-error@enderror"
                    @error('solicitante') aria-invalid="true" @enderror>
                @foreach ($solicitantes as $solicitante)
                    <option value="{{ $solicitante->value }}" @selected(old('solicitante') === $solicitante->value)>
                        {{ $solicitante->etiqueta() }}
                    </option>
                @endforeach
            </select>
            <p id="solicitante-ayuda" class="arcop-ayuda">Si no viene el propio titular, hay que acompañar el
                documento que acredita la representación.</p>
            @include('arcop-panel::partes.error', ['campo' => 'solicitante'])
        </div>

        <div class="arcop-campo">
            @php($credencialDescripcion = trim(
                (config('arcop-panel.credencial.ayuda') ? 'credencial-ayuda ' : '')
                .($errors->has('credencial') ? 'credencial-error' : '')
            ))
            <label for="credencial">{{ config('arcop-panel.credencial.etiqueta') }}</label>
            <input id="credencial" name="credencial" type="text" value="{{ old('credencial') }}"
                   @if ($credencialDescripcion !== '') aria-describedby="{{ $credencialDescripcion }}" @endif
                   @error('credencial') aria-invalid="true" @enderror>
            @if (config('arcop-panel.credencial.ayuda'))
                <p id="credencial-ayuda" class="arcop-ayuda">{{ config('arcop-panel.credencial.ayuda') }}</p>
            @endif
            @include('arcop-panel::partes.error', ['campo' => 'credencial'])
        </div>

        <div class="arcop-campo">
            {{-- Un archivo, nunca una ruta tipeada: la ruta en el disco de
                 evidencia la decide el panel. El núcleo borra ese documento al
                 suprimir al titular, y una ruta escrita a mano permitía borrar
                 el documento de otro vecino. --}}
            <label for="acreditacion">Documento que acredita la representación</label>
            <input id="acreditacion" name="acreditacion" type="file"
                   accept="application/pdf,image/jpeg,image/png"
                   aria-describedby="acreditacion-ayuda@error('acreditacion') acreditacion-error@enderror"
                   @error('acreditacion') aria-invalid="true" @enderror>
            <p id="acreditacion-ayuda" class="arcop-ayuda">PDF, JPG o PNG de hasta 5 MB. Obligatorio cuando no
                viene el propio titular; dejalo en blanco cuando actúa la propia persona.</p>
            @include('arcop-panel::partes.error', ['campo' => 'acreditacion'])
        </div>

        <div class="arcop-campo">
            <label for="detalle">Detalle que dicta el ciudadano</label>
            <textarea id="detalle" name="detalle" rows="5" required
                      aria-describedby="detalle-ayuda@error('detalle') detalle-error@enderror"
                      @error('detalle') aria-invalid="true" @enderror>{{ old('detalle') }}</textarea>
            <p id="detalle-ayuda" class="arcop-ayuda">Escribí lo que pide con sus palabras: es lo que va a
                tener que responderse.</p>
            @include('arcop-panel::partes.error', ['campo' => 'detalle'])
        </div>

        <button class="arcop-boton arcop-boton--principal" type="submit">Recibir la solicitud</button>
    </form>
@endsection
